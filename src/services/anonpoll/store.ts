import { and, count, eq } from "drizzle-orm";

import { anonPolls, anonPollVoters } from "../../db/schema";
import type { DatabaseService, Transaction } from "../database";
import type { PollCipher } from "./cipher";

/**
 * Storage for anonymous polls.
 *
 * No individual ballots are stored. We record *who* has voted (to prevent
 * double voting and to gate results) and a tally per poll, and nothing that
 * links the two. The tables live in the main database, which anyone can read
 * through SQL queries sent to the bot, so everything but the poll ID is
 * encrypted or hashed with the secret key: see {@link PollCipher}.
 */
export class AnonPollStore {
	readonly #db: DatabaseService;
	readonly #cipher: PollCipher;

	constructor(db: DatabaseService, cipher: PollCipher) {
		this.#db = db;
		this.#cipher = cipher;
	}

	#encryptInfo(poll: PollInfo): Buffer {
		const { id, ...info } = poll;
		return this.#cipher.encrypt(id, "info", Buffer.from(JSON.stringify(info)));
	}

	#decryptInfo(row: { id: string; info: Uint8Array }): PollInfo {
		return {
			id: row.id,
			...JSON.parse(this.#cipher.decrypt(row.id, "info", row.info).toString()),
		};
	}

	#get(tx: Transaction, id: string) {
		return tx.select().from(anonPolls).where(eq(anonPolls.id, id)).get();
	}

	#setInfo(tx: Transaction, poll: PollInfo) {
		tx.update(anonPolls)
			.set({ info: this.#encryptInfo(poll) })
			.where(eq(anonPolls.id, poll.id))
			.run();
	}

	/** @param closesAt seconds since epoch */
	createPoll(poll: {
		id: string;
		question: string;
		choices: string[];
		channelId: string;
		closesAt: number;
	}) {
		const info = this.#encryptInfo({ ...poll, messageId: null, closed: false });
		const tally = this.#cipher.encryptTally(
			poll.id,
			poll.choices.map(() => 0),
		);
		this.#db.querySync("create anonymous poll", (tx) =>
			tx.insert(anonPolls).values({ id: poll.id, info, tally }).run(),
		);
	}

	setMessageId(pollId: string, messageId: string) {
		this.#db.querySync("set anonymous poll message", (tx) => {
			const row = this.#get(tx, pollId);
			if (row) this.#setInfo(tx, { ...this.#decryptInfo(row), messageId });
		});
	}

	/** @param now seconds since epoch */
	castVote(pollId: string, userId: string, choiceIdx: number, now: number): CastVoteResult {
		return this.#db.querySync("cast anonymous vote", (tx): CastVoteResult => {
			const row = this.#get(tx, pollId);
			if (!row) return "no_poll";
			const poll = this.#decryptInfo(row);
			// The close job runs once a minute, so also check the deadline itself.
			if (poll.closed || poll.closesAt <= now) return "closed";
			if (!Number.isInteger(choiceIdx) || choiceIdx < 0 || choiceIdx >= poll.choices.length) {
				return "bad_choice";
			}
			const inserted = tx
				.insert(anonPollVoters)
				.values({ poll_id: pollId, voter: this.#cipher.voterId(pollId, userId) })
				.onConflictDoNothing()
				.returning()
				.get();
			if (!inserted) return "already_voted";
			const counts = this.#cipher.decryptTally(pollId, row.tally);
			counts[choiceIdx]!++;
			tx.update(anonPolls)
				.set({ tally: this.#cipher.encryptTally(pollId, counts) })
				.where(eq(anonPolls.id, pollId))
				.run();
			return "ok";
		});
	}

	hasVoted(pollId: string, userId: string): boolean {
		const voter = this.#cipher.voterId(pollId, userId);
		return this.#db.querySync(
			"check anonymous voter",
			(tx) =>
				tx
					.select()
					.from(anonPollVoters)
					.where(and(eq(anonPollVoters.poll_id, pollId), eq(anonPollVoters.voter, voter)))
					.get() !== undefined,
		);
	}

	voterCount(pollId: string): number {
		return this.#db.querySync(
			"count anonymous voters",
			(tx) =>
				tx
					.select({ n: count() })
					.from(anonPollVoters)
					.where(eq(anonPollVoters.poll_id, pollId))
					.get()?.n ?? 0,
		);
	}

	/**
	 * Marks every open poll whose deadline has passed as closed. Deadlines are
	 * encrypted, so this decrypts every poll; there are few enough for that.
	 * @param now seconds since epoch
	 * @returns the polls that were closed
	 */
	closeDuePolls(now: number): PollInfo[] {
		return this.#db.querySync("close anonymous polls", (tx) => {
			const due = tx
				.select()
				.from(anonPolls)
				.all()
				.map((row) => this.#decryptInfo(row))
				.filter((p) => !p.closed && p.closesAt <= now)
				.map((p) => ({ ...p, closed: true }));
			for (const poll of due) this.#setInfo(tx, poll);
			return due;
		});
	}

	/** Deadlines (seconds since epoch) of polls that haven't been closed yet */
	openPollDeadlines(): number[] {
		return this.#db
			.querySync("open anonymous poll deadlines", (tx) => tx.select().from(anonPolls).all())
			.map((row) => this.#decryptInfo(row))
			.filter((p) => !p.closed)
			.map((p) => p.closesAt);
	}

	getPoll(id: string): PollInfo | null {
		const row = this.#db.querySync("get anonymous poll", (tx) => this.#get(tx, id));
		return row ? this.#decryptInfo(row) : null;
	}

	getResults(pollId: string): PollResults | null {
		const row = this.#db.querySync("get anonymous poll results", (tx) => this.#get(tx, pollId));
		if (!row) return null;
		const poll = this.#decryptInfo(row);
		const counts = this.#cipher.decryptTally(pollId, row.tally);
		return {
			question: poll.question,
			choices: poll.choices.map((text, i) => ({ text, count: counts[i] ?? 0 })),
		};
	}
}

export type CastVoteResult = "ok" | "already_voted" | "closed" | "no_poll" | "bad_choice";

export interface PollInfo {
	id: string;
	question: string;
	choices: string[];
	channelId: string;
	messageId: string | null;
	/** Seconds since epoch */
	closesAt: number;
	closed: boolean;
}

export interface PollResults {
	question: string;
	choices: { text: string; count: number }[];
}
