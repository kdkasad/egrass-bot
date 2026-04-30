import * as Sentry from "@sentry/bun";
import { eq } from "drizzle-orm";
import type { Guild, Message, OmitPartialGroupDMChannel, PartialMessage, User } from "discord.js";

import { Feature } from "../utils/service";
import type { EnvService } from "./env";
import type { DiscordService } from "./discord";
import { Channels, Guilds, Roles } from "../consts";
import { addReaction, replyToMessage, traced } from "../utils/tracing";
import type { DatabaseService } from "./database";
import { mutes as mutesTable } from "../db/schema";
import { parseDuration } from "../utils/time";

const SHORT_TIMEOUT_MS = parseDuration("16.7s");
const LONG_TIMEOUT_MS = parseDuration("1d");

export class TrollService extends Feature {
	#db: DatabaseService;
	#discord: DiscordService;

	constructor(env: EnvService, discord: DiscordService, database: DatabaseService) {
		super(env);
		this.#db = database;
		this.#discord = discord;

		// Handle existing mutes even if the feature is disabled
		this.#handleExistingMutes();

		if (this.isEnabled()) {
			discord.subscribe("message:create", (m) => this.#handleMessage(m));
			discord.subscribe("message:edit", (m1, m2) => this.#handleEdit(m1, m2));
			Sentry.logger.info(`${this._name} initialized`);
		} else {
			Sentry.logger.info(`${this._name} disabled`);
		}
	}

	@traced("event.handler")
	async #handleMessage(message: OmitPartialGroupDMChannel<Message>) {
		if (message.author.bot) return;

		if (this.#test(message)) {
			await Promise.all([
				addReaction(message, "🥀"),
				replyToMessage(
					message,
					Math.random() < 0.067
						? "https://tenor.com/view/bee-movie-layton-t-montgomery-monty-montgomery-67-6-7-gif-9758470031245276788"
						: "OMG HAHA SO FUNNY SIX AND SEVEN ARE CONSECUTIVE DIGITS 🤯",
				),
				this.#mute(message.author, message.guild!),
			]);
			Sentry.logger.info("Troll response sent");
		}
	}

	#test(message: Message): boolean {
		return (
			!message.author.bot &&
			message.inGuild() &&
			(message.channel.isThread()
				? message.channel.parentId !== Channels.Announcements
				: message.channelId !== Channels.Announcements) &&
			message.content.match(/(?:\b(?:6+|six)\b.*\b(?:7+|seven)\b)|(?:\b(6+7+)+\b)/i) !== null
		);
	}

	@traced()
	async #mute(user: User, guild: Guild) {
		try {
			const member = await guild.members.fetch(user);
			await member.roles.add(Roles.Mute, "you know what you did");

			// 1/667 chance for a whole day timeout heheheha
			const useDayTimeout = Math.random() < 1 / 667;
			const expiresAt = new Date(
				Date.now() + (useDayTimeout ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS),
			);
			await this.#db.query("insert mute", (tx) =>
				tx
					.insert(mutesTable)
					.values({
						user_id: user.id,
						expires_at: Math.floor(expiresAt.getTime() / 1000),
					})
					.onConflictDoUpdate({
						target: mutesTable.user_id,
						set: {
							expires_at: Math.floor(expiresAt.getTime() / 1000),
						},
					}),
			);
			setTimeout(() => this.#unmute(user.id), expiresAt.getTime() - Date.now());
			Sentry.logger.info("User muted", {
				"user.id": user.id,
				"mute.expires_at": expiresAt,
			});
		} catch (err) {
			Sentry.logger.error(
				Sentry.logger
					.fmt`Failed to mute user ${user.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			Sentry.captureException(err);
		}
	}

	@traced()
	async #unmute(userId: string) {
		try {
			const guild = await this.#discord.client.guilds.fetch(Guilds.Egrass);
			const member = await guild.members.fetch(userId);
			await member.roles.remove(Roles.Mute);
			await this.#db.query("delete mute", (tx) =>
				tx.delete(mutesTable).where(eq(mutesTable.user_id, userId)),
			);
			Sentry.logger.info("User unmuted", { "user.id": userId });
		} catch (err) {
			Sentry.logger.error(
				Sentry.logger
					.fmt`Failed to unmute user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			Sentry.captureException(err);
		}
	}

	@traced()
	async #handleExistingMutes() {
		const rawMutes = await this.#db.query("select mutes", (tx) => tx.select().from(mutesTable));
		const mutes = rawMutes.map((m) => ({
			userId: m.user_id,
			expiresAt: new Date(m.expires_at * 1000),
		}));
		await Promise.all(
			mutes.map(async (mute) => {
				if (mute.expiresAt < new Date()) {
					await this.#unmute(mute.userId);
				} else {
					const msUntilExpiry = mute.expiresAt.getTime() - Date.now();
					setTimeout(() => this.#unmute(mute.userId), msUntilExpiry);
				}
			}),
		);
	}

	@traced("event.handler")
	async #handleEdit(
		oldMessage: OmitPartialGroupDMChannel<Message> | PartialMessage,
		newMessage: OmitPartialGroupDMChannel<Message>,
	) {
		if (oldMessage.partial) {
			oldMessage = await oldMessage.fetch();
		}
		if (!this.#test(oldMessage)) {
			await this.#handleMessage(newMessage);
		}
	}
}
