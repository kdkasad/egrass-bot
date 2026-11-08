import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
	MessageFlags,
	TextInputStyle,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
	type SlashCommandBuilder,
	type ModalBuilder,
	type InteractionReplyOptions,
} from "discord.js";
import { CreateErrors } from "./messages";
import { AnonPollService } from ".";
import { AnonPollStore } from "./store";
import { PollCipher } from "./cipher";
import { DatabaseService } from "../database";
import type { EnvService } from "../env";
import type { DiscordService } from "../discord";
import type { CronService } from "../cron";
import { MockTimeSource, parseDuration } from "../../utils/time";

const scheduled: { callback: () => void; delay: number }[] = [];
afterEach(() => {
	mock.restore();
	scheduled.length = 0;
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
	const store = new AnonPollStore(db, new PollCipher("secret"));
	const time = new MockTimeSource();
	time.setTime(new Date(100_000));
	const send = mock(async () => ({}));
	let command!: (i: ChatInputCommandInteraction) => Promise<void>;
	let submit!: (i: ModalSubmitInteraction) => Promise<void>;
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
		registerButtonHandler() {},
		client: {
			channels: {
				fetch: async () => ({
					isSendable: () => true,
					send,
					messages: { fetch: async () => ({ edit: async () => {} }) },
				}),
			},
		},
	} as unknown as DiscordService;
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: TimerHandler,
		delay?: number,
	) => {
		scheduled.push({ callback: callback as () => void, delay: delay ?? 0 });
		return {
			unref() {
				return this;
			},
		} as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout);
	return {
		env,
		db,
		store,
		time,
		discord,
		send,
		command: () => command,
		submit: () => submit,
		commandSpec: () => commandSpec,
	};
}

test("startup restores only open polls, floors overdue timers at zero, and closes each poll once", async () => {
	const f = await setup();
	for (const [id, closesAt] of [
		["expired", 90],
		["future", 110],
		["closed", 80],
	] as const) {
		f.store.createPoll({
			id,
			closesAt: new Date(closesAt * 1000),
			question: "Q?",
			choices: ["A", "B"],
		});
		f.store.setMessage(id, {
			message_id: id,
			guild_id: "g",
			channel_id: "c",
			user_id: "bot",
			timestamp: 1,
			content: "poll",
		});
	}
	f.store.closePoll("closed", new Date(100_000));
	new AnonPollService(f.env, f.discord, f.db, f.time);
	expect(scheduled.map((t) => t.delay)).toEqual([0, 10_000]);
	scheduled[0]!.callback();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(f.store.getPoll("expired")!.closed).toBe(true);
	expect(f.store.getPoll("future")!.closed).toBe(false);
	expect(f.send).toHaveBeenCalledTimes(1);
	f.time.advance({ seconds: 10 });
	scheduled[1]!.callback();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(f.store.getPoll("future")!.closed).toBe(true);
	expect(f.send).toHaveBeenCalledTimes(2);
	scheduled[1]!.callback();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(f.send).toHaveBeenCalledTimes(2);
	await f.db.stop();
});

function submission(
	id: string,
	overrides: Partial<Record<"question" | "choices" | "duration", string>> = {},
) {
	const values: Record<string, string> = {
		question: "Q?",
		choices: "A\nB",
		duration: "1d",
		...overrides,
	};
	const reply = mock(async (payload: InteractionReplyOptions) => ({
		resource: {
			message: {
				id: `message-${id}`,
				guildId: "g",
				channelId: "c",
				author: { id: "bot" },
				createdAt: new Date(100_000),
				content: payload.content,
			},
		},
	}));
	const interaction = {
		id,
		channelId: "c",
		guildId: "g",
		user: { id: "u" },
		reply,
		fields: { getTextInputValue: (name: string) => values[name]! },
	} as unknown as ModalSubmitInteraction;
	return { interaction, reply };
}

test("the argument-free command opens a modal without creating a poll or timer", async () => {
	const f = await setup();
	new AnonPollService(f.env, f.discord, f.db, f.time);
	const showModal = mock(async (modal: ModalBuilder) => modal);
	await f.command()({
		id: "command",
		user: { id: "u" },
		showModal,
	} as unknown as ChatInputCommandInteraction);
	expect(f.commandSpec().toJSON().options).toEqual([]);
	const modal = showModal.mock.calls[0]![0].toJSON();
	expect(modal.custom_id).toBe("anonpoll/create");
	expect(modal.components).toHaveLength(3);
	const fields = modal.components.map((label) => ("component" in label ? label.component : null));
	expect(fields).toMatchObject([
		{ custom_id: "question", style: TextInputStyle.Short, required: true, max_length: 300 },
		{ custom_id: "choices", style: TextInputStyle.Paragraph, required: true },
		{ custom_id: "duration", style: TextInputStyle.Short, required: false, value: "1d" },
	]);
	// If the creator cancels, no submit event arrives and there is nothing to clean up.
	expect(f.store.openPollDeadlines()).toEqual([]);
	expect(scheduled).toHaveLength(0);
	await f.db.stop();
});

test("submission trims fields, deduplicates choices while preserving order and literals, and starts the deadline at submission", async () => {
	const f = await setup();
	new AnonPollService(f.env, f.discord, f.db, f.time);
	f.time.advance({ minutes: 5 });
	const { interaction, reply } = submission("submitted", {
		question: "  Lunch?  ",
		choices: " \r\n Pizza \r\n\t\r\n1. Tacos\nA, B\r\nPizza!  \n Pizza ",
		duration: " 1w ",
	});
	await f.submit()(interaction);
	expect(f.store.getPoll("submitted")).toMatchObject({
		question: "Lunch?",
		choices: ["Pizza", "1. Tacos", "A, B", "Pizza!"],
		messageId: "message-submitted",
		closesAt: new Date(f.time.now().getTime() + parseDuration("1w")),
	});
	expect(f.store.getChannelId("submitted")).toBe("c");
	expect(scheduled.map((t) => t.delay)).toEqual([parseDuration("1w")]);
	expect(reply.mock.calls[0]![0]).toMatchObject({
		content: expect.stringContaining("Lunch?"),
		allowedMentions: { parse: [] },
		withResponse: true,
	});
	expect(reply.mock.calls[0]![0]).not.toHaveProperty("flags");
	await f.db.stop();
});

test.each(["", "   ", "1m", "1w"])(
	"accepts duration %j, with blank duration defaulting to one day",
	async (duration) => {
		const f = await setup();
		new AnonPollService(f.env, f.discord, f.db, f.time);
		const { interaction } = submission("valid", { duration });
		await f.submit()(interaction);
		expect(f.store.getPoll("valid")).not.toBeNull();
		expect(scheduled.map((t) => t.delay)).toEqual([parseDuration(duration.trim() || "1d")]);
		await f.db.stop();
	},
);

test("accepts maximum lengths and ten choices; duplicate matching is case-sensitive", async () => {
	const f = await setup();
	new AnonPollService(f.env, f.discord, f.db, f.time);
	const choices = [
		"A".repeat(100),
		"a".repeat(100),
		...Array.from({ length: 8 }, (_, i) => String(i)),
	];
	const { interaction } = submission("limits", {
		question: "Q".repeat(300),
		choices: choices.join("\n"),
	});
	await f.submit()(interaction);
	expect(f.store.getPoll("limits")!.choices).toEqual(choices);
	await f.db.stop();
});

test.each([
	[{ question: "  " }, CreateErrors.emptyQuestion],
	[{ question: "Q".repeat(301) }, CreateErrors.questionTooLong],
	[{ choices: "A\n \n" }, CreateErrors.tooFewChoices],
	[{ choices: " \n " }, CreateErrors.tooFewChoices],
	[
		{ choices: Array.from({ length: 11 }, (_, i) => String(i)).join("\n") },
		CreateErrors.tooManyChoices,
	],
	[{ choices: "A".repeat(101) + "\nB" }, CreateErrors.choiceTooLong],
	[{ choices: "A\n A " }, CreateErrors.tooFewChoices],
	[{ duration: "59s" }, CreateErrors.badDuration],
	[{ duration: "8d" }, CreateErrors.badDuration],
	[{ duration: "nonsense" }, CreateErrors.badDuration],
])("invalid submission %j creates no poll or timer", async (values, error) => {
	const f = await setup();
	new AnonPollService(f.env, f.discord, f.db, f.time);
	const { interaction, reply } = submission("invalid", values);
	await f.submit()(interaction);
	expect(reply.mock.calls[0]![0]).toEqual({
		content: `${error} ${CreateErrors.tryAgain}`,
		flags: [MessageFlags.Ephemeral],
	});
	expect(f.store.getPoll("invalid")).toBeNull();
	expect(scheduled).toHaveLength(0);
	await f.db.stop();
});
