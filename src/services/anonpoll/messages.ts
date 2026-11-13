/**
 * All user-facing text for anonymous polls.
 */

import { escapeMarkdown } from "discord.js";
import { dateToSqlite } from "../../utils/time";
import type { PollInfo, PollResults } from "./store";

/** Width of the results bar chart, in characters */
const BAR_WIDTH = 12;

function plural(n: number, word: string) {
	return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Slash command name and description */
export const CommandText = {
	name: "anon-poll",
	description: "Manage anonymous polls",
	create: "Create an anonymous poll",
	list: "List open anonymous polls",
};

export const ModalText = {
	title: "Create anonymous poll",
	visibility: "Who can see results when the poll ends?",
	participants: "Just participants",
	everyone: "Everyone",
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
	tryAgain: "Run /anon-poll create again to re-enter your poll.",
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
		`Your vote has been recorded anonymously. Results will be available to ${poll.resultsVisibility} <t:${dateToSqlite(poll.closesAt)}:R>.`,
	alreadyVoted: "You've already voted in this poll. Votes can't be changed.",
	badChoice: "That isn't a valid choice.",
	pollClosed: "This poll has closed.",
	pollNotFound: "This poll no longer exists.",
	resultsNotReady: (poll: PollInfo) =>
		`Results will be available to ${poll.resultsVisibility} <t:${dateToSqlite(poll.closesAt)}:R>.`,
	notVoted: "Only the poll author and people who voted in this poll can see its results.",
};

/** The public poll message. Never shows tallies, only the number of voters. */
export function renderPollMessage(poll: PollInfo, voters: number): string {
	const status = poll.closed
		? ["-# This poll has closed. Results are available to participants."]
		: [
				`-# Closes <t:${dateToSqlite(poll.closesAt)}:R>.`,
				`-# Votes are anonymous and can't be changed.`,
				`-# Results will be visible to ${poll.resultsVisibility}.`,
			];
	return [
		`📊 **Anonymous poll:** ${poll.question}`,
		...poll.choices.map((c, i) => `${i + 1}. ${c}`),
		`${plural(voters, "vote")}`,
		"",
		...status,
	].join("\n");
}

/** Posted in the poll's channel, with the "View results" button, when it closes */
export function renderClosedAnnouncement(poll: PollInfo): string {
	return (
		`<@${poll.authorId}>'s poll "${poll.question}" has ended. ` +
		`Results are now visible${poll.resultsVisibility === "participants" ? " to participants" : ""}.`
	);
}

/** The original message for an ended poll with public results. */
export function renderPublicClosedPoll(poll: PollInfo, results: PollResults): string {
	return [
		`📊 **Anonymous poll:** ${poll.question}`,
		...renderResultLines(results),
		"",
		`-# Poll closed <t:${dateToSqlite(poll.closesAt)}:R>`,
	].join("\n");
}

/** Results, shown privately to the author or someone who voted, once the poll has closed */
function renderResultLines(results: PollResults): string[] {
	const total = results.choices.reduce((sum, c) => sum + c.count, 0);
	const lines = results.choices.map(({ text, count }) => {
		const fraction = total === 0 ? 0 : count / total;
		const filled = Math.round(fraction * BAR_WIDTH);
		const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
		const pct = Math.round(fraction * 100);
		return `\`${bar}\` **${count}** (${pct}%) ${text}`;
	});
	lines.push(`${plural(total, "vote")} total`);
	return lines;
}

export function renderResults(results: PollResults): string {
	return [`📊 **Results:** ${results.question}`, ...renderResultLines(results)].join("\n");
}

/** Poll metadata needed to render the invoker's open-poll list. */
export interface PollListEntry {
	authorId: string;
	question: string;
	closesAt: Date;
	channelId: string;
	messageId: string;
	hasVoted: boolean;
}

/** Render complete messages, splitting at entry boundaries for Discord's limit. */
export function renderPollList(guildId: string, polls: PollListEntry[]): string[] {
	const voted: string[] = [];
	const notVoted: string[] = [];
	for (const poll of polls) {
		const group = poll.hasVoted ? voted : notVoted;
		group.push(
			`- <@${poll.authorId}>: ${escapeMarkdown(poll.question).replace(/\n/g, " ")}\n` +
				`  Ends <t:${dateToSqlite(poll.closesAt)}:R>. ` +
				`https://discord.com/channels/${guildId}/${poll.channelId}/${poll.messageId}`,
		);
	}
	const entries =
		voted.length + notVoted.length === 0
			? ["There are no open anonymous polls."]
			: [
					"## Already voted",
					...(voted.length ? voted : ["None."]),
					"## Haven't voted yet",
					...(notVoted.length ? notVoted : ["None."]),
				];
	const pages: string[] = [];
	let page = "";
	for (const entry of entries) {
		if (page.length + entry.length + 2 > 2000) {
			pages.push(page);
			page = "";
		}
		page += `${page ? "\n\n" : ""}${entry}`;
	}
	if (page) pages.push(page);
	return pages;
}
