import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
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
	const discord = {
		registerSlashCommand(_spec: SlashCommandBuilder, handler: typeof command) {
			command = handler;
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
	return { env, db, store, time, discord, send, command: () => command };
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

test("accepts one week, schedules a new poll, and rejects durations beyond a week", async () => {
	const f = await setup();
	new AnonPollService(f.env, f.discord, f.db, f.time);
	for (const duration of ["1w", "8d"]) {
		const reply = mock(async (payload: unknown) => payload);
		const interaction = {
			id: duration,
			channelId: "c",
			guildId: "g",
			user: { id: "u" },
			options: {
				getString: (name: string) =>
					({ question: "Q?", choice1: "A", choice2: "B", duration })[name] ?? null,
			},
			reply,
			fetchReply: async () => ({
				id: "m",
				author: { id: "bot" },
				createdAt: new Date(100_000),
				content: "poll",
			}),
		} as unknown as ChatInputCommandInteraction;
		await f.command()(interaction);
		if (duration === "1w") {
			expect(f.store.getPoll(duration)!.messageId).toBe("m");
			expect(f.store.getChannelId(duration)).toBe("c");
			expect(scheduled.map((t) => t.delay)).toEqual([parseDuration("1w")]);
		} else {
			expect(f.store.getPoll(duration)).toBeNull();
			expect(reply.mock.calls[0]).toEqual([
				{ content: expect.stringContaining("1 week"), flags: [64] },
			]);
			expect(scheduled).toHaveLength(1);
		}
	}
	await f.db.stop();
});
