import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { QueryResultFormat, type QueryWorkerResult } from "../../types/query";
import { anonPolls, anonPollVoters } from "../../db/schema";
import type { CronService } from "../cron";
import { DatabaseService } from "../database";
import type { EnvService } from "../env";
import { AnonPollStore, type PollInfo } from "./store";
import { PollCipher } from "./cipher";
import { renderClosedAnnouncement, renderPollMessage, renderResults } from "./messages";

const POLL = "poll1";
const ALICE = "alice";
const BOB = "bob";
const CREATED = 1_000;
const CLOSES = 2_000;

async function newStore(file = ":memory:", secret = "secret") {
	const env = { vars: { DATABASE_FILE: file } } as unknown as EnvService;
	const cron = { createJob() {} } as unknown as CronService;
	const db = await DatabaseService.new(env, cron);
	return { db, store: new AnonPollStore(db, new PollCipher(secret)) };
}

/** Runs `sql` the way the bot runs queries sent by users */
function runUserQuery(dbFile: string, sql: string): Promise<QueryWorkerResult> {
	return new Promise((resolve) => {
		const worker = new Worker(new URL("../../workers/query.ts", import.meta.url));
		worker.onmessage = (e) => {
			resolve(e.data);
			worker.terminate();
		};
		worker.postMessage({ sql, format: QueryResultFormat.JSON, dbFile });
	});
}

describe("AnonPollStore", () => {
	let store: AnonPollStore;
	beforeEach(async () => {
		({ store } = await newStore());
		store.createPoll({
			id: POLL,
			question: "Pizza or tacos?",
			choices: ["Pizza", "Tacos", "Neither"],
			channelId: "chan",
			closesAt: CLOSES,
		});
		store.setMessageId(POLL, "msg");
	});

	test("new poll is open with zero votes", () => {
		expect(store.voterCount(POLL)).toBe(0);
		expect(store.getPoll(POLL)).toEqual({
			id: POLL,
			question: "Pizza or tacos?",
			choices: ["Pizza", "Tacos", "Neither"],
			channelId: "chan",
			messageId: "msg",
			closesAt: CLOSES,
			closed: false,
		});
		expect(store.getResults(POLL)!.choices.map((c) => c.count)).toEqual([0, 0, 0]);
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

	test("votes are rejected once the deadline passes, even before the close job runs", () => {
		expect(store.castVote(POLL, ALICE, 0, CLOSES)).toBe("closed");
		expect(store.hasVoted(POLL, ALICE)).toBe(false);
	});

	test("closeDuePolls closes only polls past their deadline, once", () => {
		store.createPoll({
			id: "later",
			question: "Later?",
			choices: ["Yes", "No"],
			channelId: "chan",
			closesAt: CLOSES + 100,
		});
		expect(store.closeDuePolls(CLOSES - 1)).toEqual([]);
		const closed = store.closeDuePolls(CLOSES);
		expect(closed.map((p) => [p.id, p.closed])).toEqual([[POLL, true]]);
		expect(store.closeDuePolls(CLOSES)).toEqual([]);
		expect(store.getPoll("later")!.closed).toBe(false);
		expect(store.castVote(POLL, ALICE, 0, CREATED)).toBe("closed");
	});

	test("polls are independent", () => {
		store.createPoll({
			id: "poll2",
			question: "Yes?",
			choices: ["Yes", "No"],
			channelId: "chan",
			closesAt: CLOSES,
		});
		store.castVote(POLL, ALICE, 0, CREATED);
		expect(store.hasVoted("poll2", ALICE)).toBe(false);
		expect(store.castVote("poll2", ALICE, 1, CREATED)).toBe("ok");
		expect(store.voterCount("poll2")).toBe(1);
	});
});

describe("anonymity", () => {
	test("the database holds nothing readable but the poll ID", async () => {
		const { store, db } = await newStore();
		store.createPoll({
			id: POLL,
			question: "Pizza or tacos?",
			choices: ["Pizza", "Tacos"],
			channelId: "chan123",
			closesAt: CLOSES,
		});
		const tally = () =>
			db.querySync("read", (tx) => tx.select().from(anonPolls).get()!.tally) as Buffer;
		const before = tally();
		store.castVote(POLL, ALICE, 0, CREATED);
		const after = tally();
		// Same length and fully re-encrypted, so a diff doesn't reveal the choice
		expect(after.length).toBe(before.length);
		expect(after.equals(before)).toBe(false);

		const dump = JSON.stringify(
			db.querySync("dump", (tx) => [
				tx.select().from(anonPolls).all(),
				tx.select().from(anonPollVoters).all(),
			]),
		);
		for (const secret of ["Pizza", "chan123", String(CLOSES), ALICE]) {
			expect(dump).not.toContain(secret);
		}
	});

	test("data can't be read with another key or moved to another poll or field", () => {
		const blob = new PollCipher("secret").encryptTally(POLL, [1, 2]);
		expect(new PollCipher("secret").decryptTally(POLL, blob)).toEqual([1, 2]);
		expect(() => new PollCipher("other").decryptTally(POLL, blob)).toThrow();
		expect(() => new PollCipher("secret").decryptTally("poll2", blob)).toThrow();
		expect(() => new PollCipher("secret").decrypt(POLL, "info", blob)).toThrow();
	});

	test("user SQL queries see nothing readable", async () => {
		const dir = mkdtempSync(`${tmpdir()}/anonpoll-`);
		try {
			const file = `${dir}/db.sqlite3`;
			const { db, store } = await newStore(file);
			store.createPoll({
				id: POLL,
				question: "Pizza or tacos?",
				choices: ["Pizza", "Tacos"],
				channelId: "chan123",
				closesAt: CLOSES,
			});
			store.setMessageId(POLL, "msg456");
			store.castVote(POLL, "526907259872083988", 1, CREATED);
			await db.stop();

			for (const sql of [
				"SELECT *, CAST(info AS TEXT), CAST(tally AS TEXT) FROM anon_polls",
				"SELECT * FROM anon_poll_voters",
			]) {
				const result = await runUserQuery(file, sql);
				expect(result.status).toBe("success");
				const output = (result as { formattedResult: string }).formattedResult;
				expect(output).toContain(POLL);
				for (const secret of [
					"Pizza",
					"Tacos",
					"chan123",
					"msg456",
					String(CLOSES),
					"526907259872083988",
				]) {
					expect(output).not.toContain(secret);
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the tally's size never changes, even when a count gains a digit", async () => {
		const { store, db } = await newStore();
		store.createPoll({
			id: POLL,
			question: "Q?",
			choices: ["A", "B"],
			channelId: "c",
			closesAt: CLOSES,
		});
		const tallySize = () =>
			db.querySync("read", (tx) => tx.select().from(anonPolls).get()!.tally).length;
		const size = tallySize();
		for (let i = 0; i < 12; i++) {
			expect(store.castVote(POLL, `user${i}`, 0, CREATED)).toBe("ok");
			expect(tallySize()).toBe(size);
		}
		expect(store.getResults(POLL)!.choices.map((c) => c.count)).toEqual([12, 0]);
	});

	test("polls survive a restart with the same key, and are unreadable with another", async () => {
		const dir = mkdtempSync(`${tmpdir()}/anonpoll-`);
		try {
			const file = `${dir}/db.sqlite3`;
			const first = await newStore(file);
			first.store.createPoll({
				id: POLL,
				question: "Q?",
				choices: ["A", "B"],
				channelId: "c",
				closesAt: CLOSES,
			});
			first.store.castVote(POLL, ALICE, 1, CREATED);
			await first.db.stop();

			const same = await newStore(file);
			expect(same.store.getPoll(POLL)!.question).toBe("Q?");
			expect(same.store.hasVoted(POLL, ALICE)).toBe(true);
			expect(same.store.castVote(POLL, ALICE, 0, CREATED)).toBe("already_voted");
			expect(same.store.getResults(POLL)!.choices.map((c) => c.count)).toEqual([0, 1]);
			await same.db.stop();

			const other = await newStore(file, "wrong secret");
			expect(() => other.store.getPoll(POLL)).toThrow();
			expect(() => other.store.getResults(POLL)).toThrow();
			expect(other.store.hasVoted(POLL, ALICE)).toBe(false);
			await other.db.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("open deadlines are read from encrypted data", async () => {
		const { store } = await newStore();
		store.createPoll({
			id: "a",
			question: "Q?",
			choices: ["A", "B"],
			channelId: "c",
			closesAt: CLOSES,
		});
		store.createPoll({
			id: "b",
			question: "Q?",
			choices: ["A", "B"],
			channelId: "c",
			closesAt: CLOSES + 100,
		});
		expect(store.openPollDeadlines().sort()).toEqual([CLOSES, CLOSES + 100]);
		store.closeDuePolls(CLOSES);
		expect(store.openPollDeadlines()).toEqual([CLOSES + 100]);
	});

	test("voter hashes differ between polls", () => {
		const cipher = new PollCipher("secret");
		expect(cipher.voterId(POLL, ALICE)).not.toBe(cipher.voterId("poll2", ALICE));
	});
});

describe("render", () => {
	const poll: PollInfo = {
		id: POLL,
		question: "Q?",
		choices: ["A", "B"],
		channelId: "chan",
		messageId: "msg",
		closesAt: CLOSES,
		closed: false,
	};

	test("public message never contains tallies", () => {
		const msg = renderPollMessage(poll, 3);
		expect(msg).toContain("3 votes");
		expect(msg).toContain(`<t:${CLOSES}:R>`);
		expect(msg).not.toContain("%");
	});

	test("closed announcement says results are available to voters", () => {
		expect(renderClosedAnnouncement({ ...poll, closed: true }, 1)).toContain(
			"has closed with 1 vote. Results are now available to everyone who voted",
		);
	});

	test("results show counts and percentages", () => {
		const text = renderResults({
			question: "Q?",
			choices: [
				{ text: "A", count: 3 },
				{ text: "B", count: 1 },
			],
		});
		expect(text).toContain("**3** (75%) A");
		expect(text).toContain("**1** (25%) B");
		expect(text).toContain("4 votes total");
	});

	test("results with no votes don't divide by zero", () => {
		const text = renderResults({ question: "Q?", choices: [{ text: "A", count: 0 }] });
		expect(text).toContain("**0** (0%) A");
	});
});
