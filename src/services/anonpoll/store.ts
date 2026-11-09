import { and, asc, count, eq, lte } from "drizzle-orm";

import { anonPolls, anonPollChoices, anonPollVoters, messages } from "../../db/schema";
import type { DatabaseService, Transaction } from "../database";
import type { PollCipher } from "./cipher";

/**
 * Storage for anonymous polls.
 */
export class AnonPollStore {
	readonly #db: DatabaseService;
	readonly #cipher: PollCipher;

	constructor(db: DatabaseService, cipher: PollCipher) {
		this.#db = db;
		this.#cipher = cipher;
	}

	#get(tx: Transaction, id: string) {
		return tx.select().from(anonPolls).where(eq(anonPolls.id, id)).get();
	}

	#choices(tx: Transaction, pollId: string) {
		return tx
			.select({ id: anonPollChoices.choice_id, text: anonPollChoices.text })
			.from(anonPollChoices)
			.where(eq(anonPollChoices.poll_id, pollId))
			.orderBy(asc(anonPollChoices.choice_id))
			.all();
	}

	#choicesText(tx: Transaction, pollId: string) {
		return this.#choices(tx, pollId).map((c) => c.text);
	}

	createPoll(poll: {
		id: string;
		authorId: string;
		question: string;
		choices: string[];
		closesAt: Date;
	}) {
		const { choices, authorId, ...info } = poll;
		const tally = this.#cipher.encryptTally(choices.map(() => 0));
		this.#db.querySync("create anonymous poll", (tx) => {
			tx.insert(anonPolls)
				.values({ ...info, authorUserId: authorId, tally })
				.run();
			tx.insert(anonPollChoices)
				.values(choices.map((text, choice_id) => ({ poll_id: poll.id, choice_id, text })))
				.run();
		});
	}

	/** Persist the message before linking it, independently of gateway event timing. */
	setMessage(pollId: string, message: typeof messages.$inferInsert) {
		this.#db.querySync("set anonymous poll message", (tx) => {
			tx.insert(messages).values(message).onConflictDoNothing().run();
			tx.update(anonPolls)
				.set({ messageId: message.message_id })
				.where(eq(anonPolls.id, pollId))
				.run();
		});
	}

	getChannelId(pollId: string): string | null {
		return this.#db.querySync(
			"get anonymous poll channel",
			(tx) =>
				tx
					.select({ channelId: messages.channel_id })
					.from(anonPolls)
					.innerJoin(messages, eq(anonPolls.messageId, messages.message_id))
					.where(eq(anonPolls.id, pollId))
					.get()?.channelId ?? null,
		);
	}

	castVote(pollId: string, userId: string, choiceIdx: number, now: Date): CastVoteResult {
		if (!Number.isInteger(choiceIdx) || choiceIdx < 0) return "bad_choice";
		return this.#db.querySync("cast anonymous vote", (tx): CastVoteResult => {
			const poll = this.#get(tx, pollId);
			if (!poll) return "no_poll";
			// Check the deadline even if the close timer has not fired yet.
			if (poll.closed || poll.closesAt <= now) return "closed";
			const choice = tx
				.select({ id: anonPollChoices.choice_id })
				.from(anonPollChoices)
				.where(
					and(
						eq(anonPollChoices.poll_id, pollId),
						eq(anonPollChoices.choice_id, choiceIdx),
					),
				)
				.get();
			if (!choice) return "bad_choice";
			const inserted = tx
				.insert(anonPollVoters)
				.values({ poll_id: pollId, voter: this.#cipher.voterId(pollId, userId) })
				.onConflictDoNothing()
				.returning()
				.get();
			if (!inserted) return "already_voted";
			const counts = this.#cipher.decryptTally(poll.tally);
			counts[choiceIdx]!++;
			tx.update(anonPolls)
				.set({ tally: this.#cipher.encryptTally(counts) })
				.where(eq(anonPolls.id, pollId))
				.run();
			return "ok";
		});
	}

	isAuthor(pollId: string, userId: string): boolean {
		return this.#db.querySync(
			"check anonymous poll author",
			(tx) =>
				tx
					.select({ id: anonPolls.id })
					.from(anonPolls)
					.where(and(eq(anonPolls.id, pollId), eq(anonPolls.authorUserId, userId)))
					.get() !== undefined,
		);
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

	/** Atomically close poll, only if its deadline has passed. */
	closePoll(pollId: string, now: Date): PollInfo | null {
		return this.#db.querySync("close anonymous poll", (tx) => {
			const poll = tx
				.update(anonPolls)
				.set({ closed: true })
				.where(
					and(
						eq(anonPolls.id, pollId),
						eq(anonPolls.closed, false),
						lte(anonPolls.closesAt, now),
					),
				)
				.returning()
				.get();
			return poll ? { ...poll, choices: this.#choicesText(tx, pollId) } : null;
		});
	}

	/** Fetch scheduling data for open polls. */
	openPollDeadlines(): { id: string; closesAt: Date }[] {
		return this.#db.querySync("open anonymous poll deadlines", (tx) =>
			tx
				.select({ id: anonPolls.id, closesAt: anonPolls.closesAt })
				.from(anonPolls)
				.where(eq(anonPolls.closed, false))
				.all(),
		);
	}

	getPoll(id: string): PollInfo | null {
		return this.#db.querySync("get anonymous poll", (tx) => {
			const poll = tx
				.select({
					id: anonPolls.id,
					question: anonPolls.question,
					messageId: anonPolls.messageId,
					closesAt: anonPolls.closesAt,
					closed: anonPolls.closed,
				})
				.from(anonPolls)
				.where(eq(anonPolls.id, id))
				.get();
			return poll ? { ...poll, choices: this.#choicesText(tx, id) } : null;
		});
	}

	getResults(pollId: string): PollResults | null {
		return this.#db.querySync("get anonymous poll results", (tx) => {
			const poll = this.#get(tx, pollId);
			if (!poll) return null;
			const counts = this.#cipher.decryptTally(poll.tally);
			return {
				question: poll.question,
				choices: this.#choices(tx, pollId).map(({ id, text }) => ({
					text,
					count: counts[id]!,
				})),
			};
		});
	}
}

export type CastVoteResult = "ok" | "already_voted" | "closed" | "no_poll" | "bad_choice";

export interface PollInfo {
	id: string;
	question: string;
	choices: string[];
	messageId: string | null;
	closesAt: Date;
	closed: boolean;
}

export interface PollResults {
	question: string;
	choices: { text: string; count: number }[];
}
