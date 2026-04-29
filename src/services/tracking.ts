import * as Sentry from "@sentry/bun";

import {
	MessageReaction,
	MessageReferenceType,
	User,
	type Message,
	type MessageReactionEventDetails,
	type OmitPartialGroupDMChannel,
	type PartialMessage,
	type PartialMessageReaction,
	type PartialUser,
} from "discord.js";
import { Service } from "../utils/service";
import type { DatabaseService } from "./database";
import type { DiscordService } from "./discord";
import { messages, reactions } from "../db/schema";
import { and, eq } from "drizzle-orm";

export class TrackingService extends Service {
	#db: DatabaseService;

	constructor(discord: DiscordService, db: DatabaseService) {
		super();
		this.#db = db;
		discord.subscribe("message:create", async (...args) => {
			this.#handleMessageCreate(...args);
		});
		discord.subscribe("message:delete", async (...args) => {
			this.#handleMessageDelete(...args);
		});
		discord.subscribe("reaction:create", async (r, u) => {
			this.#handleReactionCreate(r, u);
		});
		discord.subscribe("reaction:delete", async (r, u) => {
			this.#handleReactionDelete(r, u);
		});
	}

	async #handleMessageCreate(message: OmitPartialGroupDMChannel<Message>) {
		return Sentry.startSpan(
			{
				name: "TrackingService.#handleMessageCreate",
				op: "event.handler",
			},
			async () => {
				if (!message.inGuild()) {
					Sentry.logger.info("Message not in guild; not tracking", {
						messageId: message.id,
						authorId: message.author.id,
					});
					return;
				}
				// Get the ID of the message that this message replies to
				const repliesTo =
					message.reference?.messageId &&
					message.reference.type === MessageReferenceType.Default
						? message.reference.messageId
						: null;
				this.#db.query("insert message", async (tx) => {
					await tx.insert(messages).values({
						id: message.id,
						author_id: message.author.id,
						channel_id: message.channelId,
						content: message.content,
						guild_id: message.guildId,
						timestamp: Math.floor(message.createdAt.getTime() / 1000),
						replies_to: repliesTo,
					});
				});
				Sentry.logger.info("Message saved in database", {
					"message.id": message.id,
				});
			},
		);
	}

	async #handleMessageDelete(message: OmitPartialGroupDMChannel<Message> | PartialMessage) {
		return Sentry.startSpan(
			{
				name: "TrackingService.#handleMessageDelete",
				op: "event.handler",
			},
			async () => {
				this.#db.query("delete message", async (tx) => {
					await tx.delete(messages).where(eq(messages.id, message.id));
				});
				Sentry.logger.info("Message deleted from database", {
					"message.id": message.id,
				});
			},
		);
	}

	async #handleReactionCreate(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	) {
		Sentry.startSpan(
			{
				name: "TrackingService.#handleReactionCreate",
				op: "event.handler",
			},
			async () => {
				const emoji = reaction.emoji.id ?? reaction.emoji.name;
				if (!emoji) {
					throw new Error("Reaction has no emoji ID or name");
				}
				this.#db.query("insert reaction", async (tx) => {
					await tx.insert(reactions).values({
						timestamp: Math.floor(Date.now() / 1000),
						emoji,
						message_id: reaction.message.id,
						user_id: user.id,
					});
				});
				Sentry.logger.info("Reaction saved in database");
			},
		);
	}

	async #handleReactionDelete(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	) {
		Sentry.startSpan(
			{
				name: "TrackingService.#handleReactionDelete",
				op: "event.handler",
			},
			async () => {
				const emoji = reaction.emoji.id ?? reaction.emoji.name;
				if (!emoji) {
					throw new Error("Reaction has no emoji ID or name");
				}
				this.#db.query("delete reaction", async (tx) => {
					await tx
						.delete(reactions)
						.where(
							and(
								eq(reactions.message_id, reaction.message.id),
								eq(reactions.user_id, user.id),
								eq(reactions.emoji, emoji),
							),
						);
				});
				Sentry.logger.info("Reaction deleted from database");
			},
		);
	}
}
