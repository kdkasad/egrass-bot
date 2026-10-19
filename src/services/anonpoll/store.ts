import { Database } from "bun:sqlite";

/**
 * Storage for anonymous polls.
 *
 * This deliberately lives in its own database file rather than the main one:
 * every table in the main database can be read by anyone through SQL queries
 * sent to the bot, which would leak results to non-voters, and the main
 * database logs query parameters, which would put a voter's ID and choice next
 * to each other in the logs.
 *
 * No individual ballots are stored. We record *who* has voted (to prevent
 * double voting and to gate results) and a counter per choice, and nothing
 * that links the two. Both tables are WITHOUT ROWID so rows are ordered by key
 * rather than insertion order, and there are no timestamps to correlate.
 *
 * WAL mode is deliberately not used: the WAL keeps a history of commits, and
 * each vote's commit touches both the voter list and one tally, so diffing
 * commits would reveal how each person voted. A rollback journal only holds
 * pages during a write and is deleted afterwards, and secure_delete zeroes
 * freed pages.
 */
export class AnonPollStore {
	readonly #db: Database;

	constructor(filename: string) {
		this.#db = new Database(filename, { strict: true, create: true });
		this.#db.run("PRAGMA journal_mode = DELETE");
		this.#db.run("PRAGMA secure_delete = ON");
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#migrate();
	}

	/**
	 * Applies any migrations newer than the database's `user_version`. This
	 * database isn't managed by drizzle, so migrations live here. Append new
	 * ones to the end; never edit existing ones.
	 */
	#migrate() {
		const migrations: string[] = [
			// 1: initial schema
			`
			CREATE TABLE IF NOT EXISTS anon_polls (
				id TEXT PRIMARY KEY NOT NULL,
				question TEXT NOT NULL,
				choices TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS anon_poll_voters (
				poll_id TEXT NOT NULL REFERENCES anon_polls(id),
				user_id TEXT NOT NULL,
				PRIMARY KEY (poll_id, user_id)
			) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS anon_poll_tallies (
				poll_id TEXT NOT NULL REFERENCES anon_polls(id),
				choice_idx INTEGER NOT NULL,
				count INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (poll_id, choice_idx)
			) WITHOUT ROWID;
			`,
			// 2: deadlines. Polls from before this have no deadline or channel to
			// announce in, so they are marked closed.
			`
			ALTER TABLE anon_polls ADD COLUMN channel_id TEXT NOT NULL DEFAULT '';
			ALTER TABLE anon_polls ADD COLUMN message_id TEXT;
			ALTER TABLE anon_polls ADD COLUMN closes_at INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE anon_polls ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
			UPDATE anon_polls SET closed = 1;
			`,
		];
		const { user_version: version } = this.#db
			.query<{ user_version: number }, []>("PRAGMA user_version")
			.get()!;
		for (let v = version; v < migrations.length; v++) {
			this.#db.transaction(() => {
				this.#db.run(migrations[v]!);
				this.#db.run(`PRAGMA user_version = ${v + 1}`);
			})();
		}
	}

	/** @param closesAt seconds since epoch */
	createPoll(poll: {
		id: string;
		question: string;
		choices: string[];
		channelId: string;
		closesAt: number;
	}) {
		this.#db.transaction(() => {
			this.#db
				.query(
					"INSERT INTO anon_polls (id, question, choices, channel_id, closes_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					poll.id,
					poll.question,
					JSON.stringify(poll.choices),
					poll.channelId,
					poll.closesAt,
				);
			const insertTally = this.#db.query(
				"INSERT INTO anon_poll_tallies (poll_id, choice_idx) VALUES (?, ?)",
			);
			for (let i = 0; i < poll.choices.length; i++) insertTally.run(poll.id, i);
		})();
	}

	setMessageId(pollId: string, messageId: string) {
		this.#db.query("UPDATE anon_polls SET message_id = ? WHERE id = ?").run(messageId, pollId);
	}

	/** @param now seconds since epoch */
	castVote(pollId: string, userId: string, choiceIdx: number, now: number): CastVoteResult {
		return this.#db.transaction((): CastVoteResult => {
			const poll = this.getPoll(pollId);
			if (!poll) return "no_poll";
			// The close job runs once a minute, so also check the deadline itself.
			if (poll.closed || poll.closesAt <= now) return "closed";
			if (!Number.isInteger(choiceIdx) || choiceIdx < 0 || choiceIdx >= poll.choices.length) {
				return "bad_choice";
			}
			const { changes } = this.#db
				.query(
					"INSERT INTO anon_poll_voters (poll_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
				)
				.run(pollId, userId);
			if (changes === 0) return "already_voted";
			this.#db
				.query(
					"UPDATE anon_poll_tallies SET count = count + 1 WHERE poll_id = ? AND choice_idx = ?",
				)
				.run(pollId, choiceIdx);
			return "ok";
		})();
	}

	hasVoted(pollId: string, userId: string): boolean {
		return (
			this.#db
				.query("SELECT 1 FROM anon_poll_voters WHERE poll_id = ? AND user_id = ?")
				.get(pollId, userId) !== null
		);
	}

	voterCount(pollId: string): number {
		const row = this.#db
			.query<
				{ n: number },
				[string]
			>("SELECT count(*) AS n FROM anon_poll_voters WHERE poll_id = ?")
			.get(pollId);
		return row?.n ?? 0;
	}

	/**
	 * Marks every open poll whose deadline has passed as closed.
	 * @param now seconds since epoch
	 * @returns the polls that were closed
	 */
	closeDuePolls(now: number): PollInfo[] {
		return this.#db.transaction(() => {
			const due = this.#db
				.query<
					{ id: string },
					[number]
				>("SELECT id FROM anon_polls WHERE closed = 0 AND closes_at <= ?")
				.all(now);
			const close = this.#db.query("UPDATE anon_polls SET closed = 1 WHERE id = ?");
			for (const { id } of due) close.run(id);
			return due.map(({ id }) => this.getPoll(id)!);
		})();
	}

	/** Deadlines (seconds since epoch) of polls that haven't been closed yet */
	openPollDeadlines(): number[] {
		return this.#db
			.query<{ closes_at: number }, []>("SELECT closes_at FROM anon_polls WHERE closed = 0")
			.all()
			.map((r) => r.closes_at);
	}

	getPoll(id: string): PollInfo | null {
		const row = this.#db
			.query<
				{
					question: string;
					choices: string;
					channel_id: string;
					message_id: string | null;
					closes_at: number;
					closed: number;
				},
				[string]
			>(
				"SELECT question, choices, channel_id, message_id, closes_at, closed FROM anon_polls WHERE id = ?",
			)
			.get(id);
		return (
			row && {
				id,
				question: row.question,
				choices: JSON.parse(row.choices),
				channelId: row.channel_id,
				messageId: row.message_id,
				closesAt: row.closes_at,
				closed: row.closed !== 0,
			}
		);
	}

	getResults(pollId: string): PollResults | null {
		const poll = this.getPoll(pollId);
		if (!poll) return null;
		const counts = this.#db
			.query<{ count: number }, [string]>(
				"SELECT count FROM anon_poll_tallies WHERE poll_id = ? ORDER BY choice_idx",
			)
			.all(pollId)
			.map((r) => r.count);
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
