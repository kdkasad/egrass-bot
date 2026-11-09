import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { members } from "../../db/schema";
import type { CronService } from "../cron";
import { DatabaseService } from "../database";
import type { EnvService } from "../env";
import { AnonPollStore } from "./store";
import { PollCipher } from "./cipher";

const POLL = "poll1";
const ALICE = "alice";
const BOB = "bob";
const CREATED = new Date(1000);
const CLOSES = new Date(2000);

function addSeconds(base: Date, seconds: number): Date {
	return new Date(base.getTime() + seconds * 1000);
}

async function newStore(file = ":memory:", secret = "secret") {
	const env = { vars: { DATABASE_FILE: file, ANONPOLL_SECRET: secret } } as unknown as EnvService;
	const cron = { createJob() {} } as unknown as CronService;
	const db = await DatabaseService.new(env, cron);
	db.querySync("seed poll author", (tx) =>
		tx
			.insert(members)
			.values({ user_id: "author", display_name: "Author", username: "author" })
			.onConflictDoNothing()
			.run(),
	);
	return { db, store: new AnonPollStore(db, new PollCipher(secret)) };
}

/** Emulate executing a user-provided arbitrary read-only SQL query */
function runUserQuery(dbFile: string, sql: string): string {
	const db = new Database(dbFile, {
		readonly: true,
		readwrite: false,
	});
	const output = JSON.stringify(db.query(sql).all());
	db.close();
	return output;
}

describe("AnonPollStore", () => {
	let store: AnonPollStore;
	beforeEach(async () => {
		({ store } = await newStore());
		store.createPoll({
			authorId: "author",
			id: POLL,
			question: "Pizza or tacos?",
			choices: ["Pizza", "Tacos", "Neither"],

			closesAt: CLOSES,
		});
		store.setMessage(POLL, {
			message_id: "msg",
			guild_id: "g",
			channel_id: "chan",
			user_id: "bot",
			timestamp: 1,
			content: "poll",
		});
	});

	test("new poll is open with zero votes", () => {
		expect(store.voterCount(POLL)).toBe(0);
		expect(store.getPoll(POLL)).toEqual({
			id: POLL,
			question: "Pizza or tacos?",
			choices: ["Pizza", "Tacos", "Neither"],

			messageId: "msg",
			closesAt: CLOSES,
			closed: false,
		});
		expect(store.getResults(POLL)!.choices.map((c) => c.count)).toEqual([0, 0, 0]);
	});

	test("channel lookup uses the tracked message and tolerates an existing row", () => {
		expect(store.getChannelId(POLL)).toBe("chan");
		// Simulate tracking winning the race to save the message.
		store.setMessage(POLL, {
			message_id: "msg",
			guild_id: "g",
			channel_id: "other",
			user_id: "bot",
			timestamp: 1,
			content: "poll",
		});
		expect(store.getChannelId(POLL)).toBe("chan");
		expect(store.getChannelId("missing")).toBeNull();
		store.createPoll({
			authorId: "author",
			id: "unlinked",
			question: "Q?",
			choices: ["A", "B"],
			closesAt: CLOSES,
		});
		expect(store.getChannelId("unlinked")).toBeNull();
	});

	test("votes are tallied and voters recorded", () => {
		expect(store.castVote(POLL, ALICE, 1, CREATED)).toBe("ok");
		expect(store.castVote(POLL, BOB, 1, CREATED)).toBe("ok");
		expect(store.voterCount(POLL)).toBe(2);
		expect(store.hasVoted(POLL, ALICE)).toBe(true);
		expect(store.getResults(POLL)!.choices.map((c) => c.count)).toEqual([0, 2, 0]);
	});

	test("a user can only vote once", () => {
		expect(store.castVote(POLL, ALICE, 0, CREATED)).toBe("ok");
		expect(store.castVote(POLL, ALICE, 1, CREATED)).toBe("already_voted");
		expect(store.getResults(POLL)!.choices.map((c) => c.count)).toEqual([1, 0, 0]);
	});

	test("invalid choices and unknown polls are rejected without recording a voter", () => {
		expect(store.castVote(POLL, ALICE, 3, CREATED)).toBe("bad_choice");
		expect(store.castVote(POLL, ALICE, -1, CREATED)).toBe("bad_choice");
		expect(store.castVote(POLL, ALICE, NaN, CREATED)).toBe("bad_choice");
		expect(store.castVote("nope", ALICE, 0, CREATED)).toBe("no_poll");
		expect(store.hasVoted(POLL, ALICE)).toBe(false);
		expect(store.getResults("nope")).toBeNull();
	});

	test("votes are rejected once the deadline passes, even before the close timer fires", () => {
		expect(store.castVote(POLL, ALICE, 0, CLOSES)).toBe("closed");
		expect(store.hasVoted(POLL, ALICE)).toBe(false);
	});

	test("closePoll closes only the requested due poll, once", () => {
		store.createPoll({
			authorId: "author",
			id: "later",
			question: "Later?",
			choices: ["Yes", "No"],

			closesAt: addSeconds(CLOSES, 1),
		});
		expect(store.closePoll(POLL, addSeconds(CLOSES, -1))).toBeNull();
		const closed = store.closePoll(POLL, CLOSES);
		expect(closed).toMatchObject({ id: POLL, closed: true });
		expect(store.closePoll(POLL, CLOSES)).toBeNull();
		expect(store.getPoll("later")!.closed).toBe(false);
		expect(store.castVote(POLL, ALICE, 0, CREATED)).toBe("closed");
	});

	test("polls are independent", () => {
		store.createPoll({
			authorId: "author",
			id: "poll2",
			question: "Yes?",
			choices: ["Yes", "No"],

			closesAt: CLOSES,
		});
		store.castVote(POLL, ALICE, 0, CREATED);
		expect(store.hasVoted("poll2", ALICE)).toBe(false);
		expect(store.castVote("poll2", ALICE, 1, CREATED)).toBe("ok");
		expect(store.voterCount("poll2")).toBe(1);
	});
});

describe("anonymity", () => {
	// This test's usefulness is questionable but we'll leave it for now
	test("user SQL queries can not read voter identities", async () => {
		const dir = mkdtempSync(`${tmpdir()}/anonpoll-`);
		try {
			const file = `${dir}/db.sqlite3`;
			const { db, store } = await newStore(file);
			store.createPoll({
				authorId: "author",
				id: POLL,
				question: "Pizza or tacos?",
				choices: ["Pizza", "Tacos"],

				closesAt: CLOSES,
			});
			store.setMessage(POLL, {
				message_id: "msg456",
				guild_id: "g",
				channel_id: "chan123",
				user_id: "bot",
				timestamp: 1,
				content: "poll",
			});
			store.castVote(POLL, "526907259872083988", 1, CREATED);
			await db.stop();

			for (const sql of [
				"SELECT *, CAST(tally AS TEXT) FROM anon_polls",
				"SELECT * FROM anon_poll_voters",
			]) {
				const output = runUserQuery(file, sql);
				expect(output).toContain(POLL);
				for (const secret of ["526907259872083988"]) {
					expect(output).not.toContain(secret);
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("polls survive restarts", async () => {
		const dir = mkdtempSync(`${tmpdir()}/anonpoll-`);
		try {
			const file = `${dir}/db.sqlite3`;
			const first = await newStore(file);
			first.store.createPoll({
				authorId: "author",
				id: POLL,
				question: "Q?",
				choices: ["A", "B"],

				closesAt: CLOSES,
			});
			first.store.castVote(POLL, ALICE, 1, CREATED);
			await first.db.stop();

			const second = await newStore(file);
			expect(second.store.getPoll(POLL)!.question).toBe("Q?");
			expect(second.store.isAuthor(POLL, "author")).toBe(true);
			expect(second.store.isAuthor(POLL, ALICE)).toBe(false);
			expect(second.store.hasVoted(POLL, ALICE)).toBe(true);
			expect(second.store.castVote(POLL, ALICE, 0, CREATED)).toBe("already_voted");
			expect(second.store.getResults(POLL)!.choices.map((c) => c.count)).toEqual([0, 1]);
			await second.db.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("voter hashes differ between polls", () => {
		const cipher = new PollCipher("secret");
		expect(cipher.voterId(POLL, ALICE)).not.toBe(cipher.voterId("poll2", ALICE));
	});
});
