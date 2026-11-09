/**
 * All user-facing text for anonymous polls.
 */

import type { PollInfo, PollResults } from "./store";

/** Width of the results bar chart, in characters */
const BAR_WIDTH = 12;

function plural(n: number, word: string) {
	return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Slash command name and description */
export const CommandText = {
	name: "anon-poll",
	description: "Create an anonymous poll",
};

export const ModalText = {
	title: "Create anonymous poll",
	question: "Question",
	choices: "Choices",
	choicesDescription: "One choice per line. 2–10 choices, up to 100 characters each.",
	duration: "Duration",
	durationDescription: "1 minute to 1 week, e.g. 10min, 1h30m, 1w. Defaults to 1d.",
};

/** Labels on the poll's dropdown and buttons */
export const ComponentText = {
	votePlaceholder: "Cast your vote",
	viewResults: "View results",
};

/** Errors shown (privately) to the poll author when the creation form is invalid */
export const CreateErrors = {
	tryAgain: "Run /anon-poll again to re-enter your poll.",
	questionTooLong: "The question must be at most 300 characters.",
	tooManyChoices: "A poll can have at most ten choices.",
	choiceTooLong: "Each choice must be at most 100 characters.",
	emptyQuestion: "The question can't be empty.",
	badDuration:
		"The duration must be between 1 minute and 1 week, e.g. `10min`, `1hr`, `1d`, `1w`.",
	tooFewChoices: "A poll needs at least two distinct choices.",
};

/** Private replies to voters and people pressing "View results" */
export const Replies = {
	voteRecorded: (poll: PollInfo) =>
		`Your vote has been recorded anonymously. Results will be available to voters and the poll author <t:${poll.closesAt}:R>.`,
	alreadyVoted: "You've already voted in this poll. Votes can't be changed.",
	badChoice: "That isn't a valid choice.",
	pollClosed: "This poll has closed.",
	pollNotFound: "This poll no longer exists.",
	resultsNotReady: (poll: PollInfo) =>
		`Results will be available to voters and the poll author <t:${poll.closesAt}:R>.`,
	notVoted: "Only the poll author and people who voted in this poll can see its results.",
};

/** The public poll message. Never shows tallies, only the number of voters. */
export function renderPollMessage(poll: PollInfo, voters: number): string {
	const status = poll.closed
		? "-# This poll has closed. Results are available to voters and the poll author in the announcement below."
		: `-# Votes are anonymous and can't be changed. Closes <t:${poll.closesAt}:R>.`;
	return [
		`📊 **Anonymous poll:** ${poll.question}`,
		...poll.choices.map((c, i) => `${i + 1}. ${c}`),
		"",
		status,
		`-# ${plural(voters, "vote")}`,
	].join("\n");
}

/** Posted in the poll's channel, with the "View results" button, when it closes */
export function renderClosedAnnouncement(poll: PollInfo, voters: number): string {
	return `📊 The anonymous poll **${poll.question}** has closed with ${plural(voters, "vote")}. Results are now available to the poll author and everyone who voted.`;
}

/** Results, shown privately to the author or someone who voted, once the poll has closed */
export function renderResults(results: PollResults): string {
	const total = results.choices.reduce((sum, c) => sum + c.count, 0);
	const lines = results.choices.map(({ text, count }) => {
		const fraction = total === 0 ? 0 : count / total;
		const filled = Math.round(fraction * BAR_WIDTH);
		const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
		const pct = Math.round(fraction * 100);
		return `\`${bar}\` **${count}** (${pct}%) ${text}`;
	});
	return [
		`📊 **Results:** ${results.question}`,
		...lines,
		`-# ${plural(total, "vote")} total`,
	].join("\n");
}
