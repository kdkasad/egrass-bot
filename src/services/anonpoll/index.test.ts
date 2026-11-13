import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	MessageFlags,
	MessageFlagsBitField,
	type ActionRowBuilder,
	type StringSelectMenuBuilder,
	type ButtonInteraction,
	type ModalSubmitInteraction,
	type InteractionReplyOptions,
	type MessageFlagsResolvable,
	type ChatInputCommandInteraction,
	type SlashCommandBuilder,
} from "discord.js";
import { members } from "../../db/schema";
import { CreateErrors, Replies } from "./messages";
import { AnonPollService } from ".";
import { AnonPollStore } from "./store";
import { PollCipher } from "./cipher";
import { DatabaseService } from "../database";
import type { EnvService } from "../env";
import type { DiscordService } from "../discord";
import type { CronService } from "../cron";
import { MockTimeSource, parseDuration } from "../../utils/time";
import type { TimerHandler } from "bun";

const databases: DatabaseService[] = [];
const flushInteractions = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(async () => {
	await flushInteractions();
	mock.restore();
	for (const db of databases.splice(0)) await db.stop();
});

async function setup() {
	const env = {
		vars: {
			DATABASE_FILE: ":memory:",
			ANONPOLL_SECRET: "secret",
			DISABLED_FEATURES: new Set(),
		},
	} as unknown as EnvService;
	const db = await DatabaseService.new(env, { createJob() {} } as unknown as CronService);
	databases.push(db);
	db.querySync("seed poll author", (tx) =>
		tx
			.insert(members)
			.values({ user_id: "author", display_name: "Author", username: "author" })
			.run(),
	);
	const store = new AnonPollStore(db, new PollCipher("secret"));
	const time = new MockTimeSource();
	time.setTime(new Date(100_000));
	const edit = mock(async (payload: InteractionReplyOptions) => payload);
	const send = mock(async (payload: { content: string }) => payload);
	let submit!: (i: ModalSubmitInteraction) => Promise<void>;
	let results!: (i: ButtonInteraction) => Promise<void>;
	let command!: (i: ChatInputCommandInteraction) => Promise<void>;
	let commandSpec!: SlashCommandBuilder;
	const discord = {
		registerSlashCommand(spec: SlashCommandBuilder, handler: typeof command) {
			commandSpec = spec;
			command = handler;
		},
		registerModalHandler(_prefix: string, handler: typeof submit) {
			submit = handler;
		},
		registerSelectMenuHandler() {},
		registerButtonHandler(_prefix: string, handler: typeof results) {
			results = handler;
		},
		client: {
			channels: {
				fetch: async () => ({
					isSendable: () => true,
					send,
					messages: { fetch: async () => ({ edit }) },
				}),
			},
		},
	} as unknown as DiscordService;

	// Keep timer mechanics in the fixture; tests advance time and observe announcements.
	const timers: { callback: () => void; at: number }[] = [];
	spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay = 0) => {
		timers.push({ callback: callback as () => void, at: time.now().getTime() + delay });
		return {
			unref() {
				return this;
			},
		} as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout);
	const advanceTime = async (milliseconds: number) => {
		time.advance({ milliseconds });
		while (true) {
			timers.sort((a, b) => a.at - b.at);
			if (!timers[0] || timers[0].at > time.now().getTime()) break;
			timers.shift()!.callback();
			await flushInteractions();
		}
	};

	const start = () => new AnonPollService(env, discord, db, time);
	const submitPoll = async (
		overrides: Partial<Record<"question" | "choices" | "duration" | "visibility", string>> = {},
	) => {
		const values: Record<string, string> = {
			question: "Q?",
			choices: "A\nB",
			duration: "1d",
			...overrides,
		};
		const reply = mock(async (payload: InteractionReplyOptions) => ({
			resource: {
				message: {
					id: "message",
					guildId: "g",
					channelId: "c",
					author: { id: "bot" },
					createdAt: time.now(),
					content: payload.content,
				},
			},
		}));
		await submit({
			id: "poll",
			channelId: "c",
			guildId: "g",
			user: { id: "author" },
			reply,
			fields: {
				getTextInputValue: (name: string) => values[name]!,
				getStringSelectValues: () => [values.visibility ?? "participants"],
			},
		} as unknown as ModalSubmitInteraction);
		return reply.mock.calls[0]![0];
	};
	const viewResults = async (userId: string) => {
		const reply = mock(async (payload: InteractionReplyOptions) => payload);
		await results({
			id: "results",
			customId: "anonpoll/results:poll",
			user: { id: userId },
			reply,
		} as unknown as ButtonInteraction);
		await flushInteractions();
		return reply.mock.calls[0]![0];
	};
	const listPolls = async () => {
		const deferReply = mock(async () => {});
		const editReply = mock(async () => {});
		const followUp = mock(async () => {});
		await command({
			options: { getSubcommand: () => "list" },
			guildId: "g",
			user: { id: "voter" },
			guild: {
				members: { fetch: async () => ({ id: "voter" }) },
				channels: { fetch: async () => ({ permissionsFor: () => ({ has: () => true }) }) },
			},
			deferReply,
			editReply,
			followUp,
		} as unknown as ChatInputCommandInteraction);
		return { deferReply, editReply, followUp };
	};
	return {
		store,
		time,
		send,
		edit,
		start,
		advanceTime,
		submitPoll,
		viewResults,
		listPolls,
		getCommandSpec: () => commandSpec.toJSON(),
	};
}

type Fixture = Awaited<ReturnType<typeof setup>>;

test("list registers a subcommand and privately groups open polls by voting status and end time", async () => {
	const f = await setup();
	for (const [id, closesAt, guild] of [
		["later", 300_000, "g"],
		["sooner", 200_000, "g"],
		["voted", 250_000, "g"],
		["expired", 90_000, "g"],
		["other-server", 200_000, "other"],
	] as const) {
		f.store.createPoll({
			id,
			authorId: "author",
			question: id,
			choices: ["A", "B"],
			closesAt: new Date(closesAt),
		});
		f.store.setMessage(id, {
			message_id: id,
			guild_id: guild,
			channel_id: "c",
			user_id: "bot",
			timestamp: 1,
			content: id,
		});
	}
	f.store.castVote("voted", "voter", 0, f.time.now());
	f.start();
	expect(f.getCommandSpec().options?.map((option) => option.name)).toEqual(["create", "list"]);
	const response = await f.listPolls();
	expect(response.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
	const content = (response.editReply.mock.calls[0] as unknown as [{ content: string }])[0]
		.content;
	expect(content).toContain("**Already voted**\n\n• voted");
	expect(content).toContain("**Haven't voted yet**\n\n• sooner");
	expect(content.indexOf("• sooner")).toBeLessThan(content.indexOf("• later"));
	expect(content).toContain("<@author>");
	expect(content).toContain("<t:200:F>");
	expect(content).toContain("https://discord.com/channels/g/c/sooner");
	expect(content).not.toContain("expired");
	expect(content).not.toContain("other-server");
});

test("list explains when there are no open polls", async () => {
	const f = await setup();
	f.start();
	const response = await f.listPolls();
	expect(response.editReply).toHaveBeenCalledWith({
		content: "There are no open anonymous polls.",
		allowedMentions: { parse: [] },
	});
});

async function createPoll(values: Parameters<Fixture["submitPoll"]>[0] = {}) {
	const f = await setup();
	f.start();
	const reply = await f.submitPoll(values);
	return { ...f, reply };
}

function choiceLabels(reply: InteractionReplyOptions) {
	const row = reply.components![0] as ActionRowBuilder<StringSelectMenuBuilder>;
	return row.toJSON().components[0]!.options.map((option) => option.label);
}

function seedPoll(f: Fixture, closesAt: Date) {
	f.store.createPoll({
		id: "poll",
		authorId: "author",
		question: "Q?",
		choices: ["A", "B"],
		closesAt,
	});
	f.store.setMessage("poll", {
		message_id: "message",
		guild_id: "g",
		channel_id: "c",
		user_id: "bot",
		timestamp: 1,
		content: "poll",
	});
}

describe("submission", () => {
	test("trims the question", async () => {
		const { reply } = await createPoll({ question: "  Lunch?  " });
		expect(reply.content).toContain("**Anonymous poll:** Lunch?\n");
	});

	test.each([
		["trims each choice", " Pizza \n\tTacos  ", ["Pizza", "Tacos"]],
		["ignores blank choice lines", "\nPizza\n \nTacos\n", ["Pizza", "Tacos"]],
		["removes duplicate choices", "Pizza\nPizza \nTacos", ["Pizza", "Tacos"]],
		["preserves choice order", "Z\nA\nM\nA", ["Z", "A", "M"]],
		[
			"preserves numbering and commas",
			"1. Pizza\nTacos, burritos",
			["1. Pizza", "Tacos, burritos"],
		],
		["treats differently cased choices as distinct", "Pizza\npizza", ["Pizza", "pizza"]],
	])("%s", async (_name, choices, expected) => {
		const { reply } = await createPoll({ choices });
		expect(choiceLabels(reply)).toEqual(expected);
	});

	test.each([
		["blank question", { question: "  " }, CreateErrors.emptyQuestion],
		[
			"question over 300 characters",
			{ question: "Q".repeat(301) },
			CreateErrors.questionTooLong,
		],
		["one choice", { choices: "A" }, CreateErrors.tooFewChoices],
		["no choices", { choices: " \n " }, CreateErrors.tooFewChoices],
		[
			"over ten choices",
			{ choices: Array.from({ length: 11 }, (_, i) => String(i)).join("\n") },
			CreateErrors.tooManyChoices,
		],
		[
			"choice over 100 characters",
			{ choices: "A".repeat(101) + "\nB" },
			CreateErrors.choiceTooLong,
		],
		["only duplicate choices", { choices: "A\n A " }, CreateErrors.tooFewChoices],
		["duration below one minute", { duration: "59s" }, CreateErrors.badDuration],
		["duration above one week", { duration: "8d" }, CreateErrors.badDuration],
		["unrecognized duration", { duration: "nonsense" }, CreateErrors.badDuration],
	])("rejects %s", async (_name, values, error) => {
		const { reply, store } = await createPoll(values);
		expect(reply.content).toBe(`${error} ${CreateErrors.tryAgain}`);
		expect(
			new MessageFlagsBitField(reply.flags as MessageFlagsResolvable).has(
				MessageFlags.Ephemeral,
			),
		).toBe(true);
		expect(store.getPoll("poll")).toBeNull();
	});
});

describe("closing", () => {
	test("starts the duration at submission", async () => {
		const f = await setup();
		f.start();
		await f.advanceTime(parseDuration("5m"));
		await f.submitPoll({ duration: "1m" });
		await f.advanceTime(parseDuration("1m") - 1);
		expect(f.send).not.toHaveBeenCalled();
		await f.advanceTime(1);
		expect(f.send).toHaveBeenCalledTimes(1);
	});

	test("restores open poll deadlines on startup", async () => {
		const f = await setup();
		seedPoll(f, new Date(f.time.now().getTime() + parseDuration("1m")));
		f.start();
		await f.advanceTime(parseDuration("1m") - 1);
		expect(f.send).not.toHaveBeenCalled();
		await f.advanceTime(1);
		expect(f.send).toHaveBeenCalledTimes(1);
	});

	test("announces overdue polls on startup", async () => {
		const f = await setup();
		seedPoll(f, new Date(f.time.now().getTime() - parseDuration("1m")));
		f.start();
		await f.advanceTime(0);
		expect(f.send).toHaveBeenCalledTimes(1);
	});

	test("does not repeat closing announcements after restart", async () => {
		const f = await createPoll({ duration: "1m" });
		await f.advanceTime(parseDuration("1m"));
		f.send.mockClear();
		f.start();
		await f.advanceTime(parseDuration("1d"));
		expect(f.send).not.toHaveBeenCalled();
	});
});

describe("results access", () => {
	async function pollWithVoter() {
		const f = await createPoll({ duration: "1m" });
		f.store.castVote("poll", "voter", 1, f.time.now());
		return f;
	}

	test.each(["author", "voter", "outsider"])("hides open results from the %s", async (user) => {
		const f = await pollWithVoter();
		const reply = await f.viewResults(user);
		expect(reply.content).toBe(Replies.resultsNotReady(f.store.getPoll("poll")!));
	});

	test.each([
		["author who did not vote", "author"],
		["voter", "voter"],
	])("shows closed results to the %s", async (_name, user) => {
		const f = await pollWithVoter();
		await f.advanceTime(parseDuration("1m"));
		const reply = await f.viewResults(user);
		expect(reply.content).toContain("**Results:** Q?");
	});

	test("denies results to outsiders", async () => {
		const f = await pollWithVoter();
		await f.advanceTime(parseDuration("1m"));
		const reply = await f.viewResults("outsider");
		expect(reply.content).toBe(Replies.notVoted);
	});

	test("sends results privately", async () => {
		const f = await pollWithVoter();
		await f.advanceTime(parseDuration("1m"));
		const reply = await f.viewResults("voter");
		expect(
			new MessageFlagsBitField(reply.flags as MessageFlagsResolvable).has(
				MessageFlags.Ephemeral,
			),
		).toBe(true);
	});
});

test("public results are persisted and shown inline only after closing", async () => {
	const f = await createPoll({ duration: "1m", visibility: "everyone" });
	expect(f.store.getPoll("poll")!.resultsVisibility).toBe("everyone");
	expect(f.reply.content).toContain("Results will be visible to everyone");
	f.store.castVote("poll", "voter", 1, f.time.now());
	expect((await f.viewResults("outsider")).content).toContain("Results will be available");
	expect(f.edit).not.toHaveBeenCalled();
	await f.advanceTime(parseDuration("1m"));
	expect(f.edit).toHaveBeenCalledTimes(1);
	const payload = f.edit.mock.calls[0]![0];
	expect(payload.content).toBe(
		"**Anonymous poll:** Q?\n`░░░░░░░░░░░░` **0** (0%) A\n`████████████` **1** (100%) B\n\n-# Poll closed <t:160:R>",
	);
	expect(payload.content).toContain("**1** (100%) B");
	expect(payload.components).toEqual([]);
	expect(f.send).toHaveBeenCalledTimes(1);
	expect(f.send.mock.calls[0]![0]).toMatchObject({
		content: '<@author>\'s poll "Q?" has ended. Results are now visible.',
		components: [],
	});
	expect((await f.viewResults("outsider")).content).toContain("**Results:** Q?");
});
