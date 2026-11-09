import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	CommandText,
	ModalText,
	ComponentText,
	CreateErrors,
	Replies,
	renderPollMessage,
	renderClosedAnnouncement,
	renderResults,
} from "./messages";
import type { PollInfo } from "./store";

// Keep interpolated dates reproducible across machines without changing renderers.
const originalTimezone = process.env.TZ;
beforeEach(() => {
	process.env.TZ = "UTC";
});
afterEach(() => {
	if (originalTimezone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimezone;
});

const poll: PollInfo = {
	id: "example-poll",
	question: "What should we order for lunch?",
	choices: ["Pizza", "Tacos", "Sushi"],
	messageId: "example-message",
	closesAt: new Date("2026-11-08T18:00:00.000Z"),
	closed: false,
};

describe("CommandText", () => {
	test("name", () => {
		expect(CommandText.name).toMatchInlineSnapshot(`"anon-poll"`);
	});

	test("description", () => {
		expect(CommandText.description).toMatchInlineSnapshot(`"Create an anonymous poll"`);
	});
});

describe("ModalText", () => {
	test("title", () => {
		expect(ModalText.title).toMatchInlineSnapshot(`"Create anonymous poll"`);
	});

	test("question", () => {
		expect(ModalText.question).toMatchInlineSnapshot(`"Question"`);
	});

	test("choices", () => {
		expect(ModalText.choices).toMatchInlineSnapshot(`"Choices"`);
	});

	test("choicesDescription", () => {
		expect(ModalText.choicesDescription).toMatchInlineSnapshot(
			`"One choice per line. 2–10 choices, up to 100 characters each."`,
		);
	});

	test("duration", () => {
		expect(ModalText.duration).toMatchInlineSnapshot(`"Duration"`);
	});

	test("durationDescription", () => {
		expect(ModalText.durationDescription).toMatchInlineSnapshot(
			`"1 minute to 1 week, e.g. 10min, 1h30m, 1w. Defaults to 1d."`,
		);
	});
});

describe("ComponentText", () => {
	test("votePlaceholder", () => {
		expect(ComponentText.votePlaceholder).toMatchInlineSnapshot(`"Cast your vote"`);
	});

	test("viewResults", () => {
		expect(ComponentText.viewResults).toMatchInlineSnapshot(`"View results"`);
	});
});

describe("CreateErrors", () => {
	test("tryAgain", () => {
		expect(CreateErrors.tryAgain).toMatchInlineSnapshot(
			`"Run /anon-poll again to re-enter your poll."`,
		);
	});

	test("questionTooLong", () => {
		expect(CreateErrors.questionTooLong).toMatchInlineSnapshot(
			`"The question must be at most 300 characters."`,
		);
	});

	test("tooManyChoices", () => {
		expect(CreateErrors.tooManyChoices).toMatchInlineSnapshot(
			`"A poll can have at most ten choices."`,
		);
	});

	test("choiceTooLong", () => {
		expect(CreateErrors.choiceTooLong).toMatchInlineSnapshot(
			`"Each choice must be at most 100 characters."`,
		);
	});

	test("emptyQuestion", () => {
		expect(CreateErrors.emptyQuestion).toMatchInlineSnapshot(`"The question can't be empty."`);
	});

	test("badDuration", () => {
		expect(CreateErrors.badDuration).toMatchInlineSnapshot(
			`"The duration must be between 1 minute and 1 week, e.g. \`10min\`, \`1hr\`, \`1d\`, \`1w\`."`,
		);
	});

	test("tooFewChoices", () => {
		expect(CreateErrors.tooFewChoices).toMatchInlineSnapshot(
			`"A poll needs at least two distinct choices."`,
		);
	});
});

describe("Replies", () => {
	test("voteRecorded", () => {
		expect(Replies.voteRecorded(poll)).toMatchInlineSnapshot(
			`"Your vote has been recorded anonymously. Results will be available to voters and the poll author <t:1794160800:R>."`,
		);
	});

	test("alreadyVoted", () => {
		expect(Replies.alreadyVoted).toMatchInlineSnapshot(
			`"You've already voted in this poll. Votes can't be changed."`,
		);
	});

	test("badChoice", () => {
		expect(Replies.badChoice).toMatchInlineSnapshot(`"That isn't a valid choice."`);
	});

	test("pollClosed", () => {
		expect(Replies.pollClosed).toMatchInlineSnapshot(`"This poll has closed."`);
	});

	test("pollNotFound", () => {
		expect(Replies.pollNotFound).toMatchInlineSnapshot(`"This poll no longer exists."`);
	});

	test("resultsNotReady", () => {
		expect(Replies.resultsNotReady(poll)).toMatchInlineSnapshot(
			`"Results will be available to voters and the poll author <t:1794160800:R>."`,
		);
	});

	test("notVoted", () => {
		expect(Replies.notVoted).toMatchInlineSnapshot(
			`"Only the poll author and people who voted in this poll can see its results."`,
		);
	});
});

describe("public poll", () => {
	test("open with no votes", () => {
		expect(renderPollMessage(poll, 0)).toMatchInlineSnapshot(`
		  "📊 **Anonymous poll:** What should we order for lunch?
		  1. Pizza
		  2. Tacos
		  3. Sushi

		  -# Votes are anonymous and can't be changed. Closes <t:1794160800:R>.
		  -# 0 votes"
		`);
	});

	test("open with one vote", () => {
		expect(renderPollMessage(poll, 1)).toMatchInlineSnapshot(`
		  "📊 **Anonymous poll:** What should we order for lunch?
		  1. Pizza
		  2. Tacos
		  3. Sushi

		  -# Votes are anonymous and can't be changed. Closes <t:1794160800:R>.
		  -# 1 vote"
		`);
	});

	test("closed", () => {
		expect(renderPollMessage({ ...poll, closed: true }, 8)).toMatchInlineSnapshot(`
		  "📊 **Anonymous poll:** What should we order for lunch?
		  1. Pizza
		  2. Tacos
		  3. Sushi

		  -# This poll has closed. Results are available to voters and the poll author in the announcement below.
		  -# 8 votes"
		`);
	});
});

describe("closing announcement", () => {
	test("multiple votes", () => {
		expect(renderClosedAnnouncement(poll, 8)).toMatchInlineSnapshot(
			`"📊 The anonymous poll **What should we order for lunch?** has closed with 8 votes. Results are now available to the poll author and everyone who voted."`,
		);
	});

	test("one vote", () => {
		expect(renderClosedAnnouncement(poll, 1)).toMatchInlineSnapshot(
			`"📊 The anonymous poll **What should we order for lunch?** has closed with 1 vote. Results are now available to the poll author and everyone who voted."`,
		);
	});
});

describe("results", () => {
	test("mixed counts", () => {
		expect(
			renderResults({
				question: poll.question,
				choices: [
					{ text: "Pizza", count: 5 },
					{ text: "Tacos", count: 3 },
					{ text: "Sushi", count: 0 },
				],
			}),
		).toMatchInlineSnapshot(`
		  "📊 **Results:** What should we order for lunch?
		  \`████████░░░░\` **5** (63%) Pizza
		  \`█████░░░░░░░\` **3** (38%) Tacos
		  \`░░░░░░░░░░░░\` **0** (0%) Sushi
		  -# 8 votes total"
		`);
	});

	test("no votes", () => {
		expect(
			renderResults({
				question: poll.question,
				choices: poll.choices.map((text) => ({ text, count: 0 })),
			}),
		).toMatchInlineSnapshot(`
		  "📊 **Results:** What should we order for lunch?
		  \`░░░░░░░░░░░░\` **0** (0%) Pizza
		  \`░░░░░░░░░░░░\` **0** (0%) Tacos
		  \`░░░░░░░░░░░░\` **0** (0%) Sushi
		  -# 0 votes total"
		`);
	});

	test("one vote", () => {
		expect(
			renderResults({
				question: poll.question,
				choices: [
					{ text: "Pizza", count: 1 },
					{ text: "Tacos", count: 0 },
					{ text: "Sushi", count: 0 },
				],
			}),
		).toMatchInlineSnapshot(`
		  "📊 **Results:** What should we order for lunch?
		  \`████████████\` **1** (100%) Pizza
		  \`░░░░░░░░░░░░\` **0** (0%) Tacos
		  \`░░░░░░░░░░░░\` **0** (0%) Sushi
		  -# 1 vote total"
		`);
	});
});
