import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { AnonPollStore, type PollInfo } from "./store";
import { renderClosedAnnouncement, renderPollMessage, renderResults } from "./messages";

const POLL = "poll1";
const ALICE = "alice";
const BOB = "bob";
const CREATED = 1_000;
const CLOSES = 2_000;

describe("AnonPollStore", () => {
	let store: AnonPollStore;
	beforeEach(() => {
		store = new AnonPollStore(":memory:");
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

describe("AnonPollStore migrations", () => {
	test("upgrades a database created before deadlines, closing its old polls", () => {
		const path = `${tmpdir()}/anonpoll-migration-${crypto.randomUUID()}.sqlite3`;
		try {
			const old = new Database(path, { strict: true, create: true });
			old.run(`
				CREATE TABLE anon_polls (id TEXT PRIMARY KEY NOT NULL, question TEXT NOT NULL, choices TEXT NOT NULL);
				CREATE TABLE anon_poll_voters (poll_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (poll_id, user_id)) WITHOUT ROWID;
				CREATE TABLE anon_poll_tallies (poll_id TEXT NOT NULL, choice_idx INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (poll_id, choice_idx)) WITHOUT ROWID;
				INSERT INTO anon_polls VALUES ('old', 'Old?', '["A","B"]');
				INSERT INTO anon_poll_voters VALUES ('old', 'alice');
				INSERT INTO anon_poll_tallies VALUES ('old', 0, 1), ('old', 1, 0);
			`);
			old.close();

			const store = new AnonPollStore(path);
			expect(store.getPoll("old")!.closed).toBe(true);
			expect(store.closeDuePolls(CLOSES)).toEqual([]);
			expect(store.hasVoted("old", ALICE)).toBe(true);
			store.createPoll({
				id: POLL,
				question: "New?",
				choices: ["A", "B"],
				channelId: "chan",
				closesAt: CLOSES,
			});
			expect(store.castVote(POLL, ALICE, 0, CREATED)).toBe("ok");
			// A WAL would keep a per-vote history linking voters to choices
			expect(existsSync(`${path}-wal`)).toBe(false);
		} finally {
			for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
		}
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
