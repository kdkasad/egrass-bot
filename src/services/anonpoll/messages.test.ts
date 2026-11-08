import { describe, expect, test } from "bun:test";
import type { PollInfo } from "./store";
import { renderClosedAnnouncement, renderPollMessage, renderResults } from "./messages";

const POLL = "poll1";
const CLOSES = new Date(2000);

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
