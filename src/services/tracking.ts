import * as Sentry from "@sentry/bun";
import { and, eq } from "drizzle-orm";
import {
	GuildMember,
	MessageReaction,
	MessageReferenceType,
	User,
	type Message,
	type OmitPartialGroupDMChannel,
	type PartialMessage,
	type PartialMessageReaction,
	type PartialUser,
} from "discord.js";

import { Service } from "../utils/service";
import { traced } from "../utils/tracing";
import type { DatabaseService } from "./database";
import type { DiscordService } from "./discord";
import { members as membersTable, messages, reactions } from "../db/schema";
import { Guilds } from "../consts";

export class TrackingService extends Service {
	#db: DatabaseService;

	constructor(discord: DiscordService, db: DatabaseService) {
		super();
		this.#db = db;
		discord.subscribe("message:create", (msg) => this.#handleMessageCreate(msg));
		discord.subscribe("message:delete", (msg) => this.#handleMessageDelete(msg));
		discord.subscribe("reaction:create", (r, u) => this.#handleReactionCreate(r, u));
		discord.subscribe("reaction:delete", (r, u) => this.#handleReactionDelete(r, u));
		discord.subscribe("member:join", (m) => this.#handleMemberJoinOrUpdate(m));
		discord.subscribe("member:update", (_, m) => this.#handleMemberJoinOrUpdate(m));
		this.#upsertAllMembers(discord);
	}

	@traced("event.handler")
	async #handleMessageCreate(message: OmitPartialGroupDMChannel<Message>) {
		if (!message.inGuild()) {
			Sentry.logger.info("Message not in guild; not tracking", {
				messageId: message.id,
				authorId: message.author.id,
			});
			return;
		}
		const repliesTo =
			message.reference?.messageId && message.reference.type === MessageReferenceType.Default
				? message.reference.messageId
				: null;
		await this.#db.query("insert message", async (tx) => {
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
	}

	@traced("event.handler")
	async #handleMessageDelete(message: OmitPartialGroupDMChannel<Message> | PartialMessage) {
		await this.#db.query("delete message", async (tx) => {
			await tx.delete(messages).where(eq(messages.id, message.id));
		});
		Sentry.logger.info("Message deleted from database", {
			"message.id": message.id,
		});
	}

	@traced("event.handler")
	async #handleReactionCreate(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	) {
		const emoji = reaction.emoji.id ?? reaction.emoji.name;
		if (!emoji) {
			throw new Error("Reaction has no emoji ID or name");
		}
		await this.#db.query("insert reaction", async (tx) => {
			await tx.insert(reactions).values({
				timestamp: Math.floor(Date.now() / 1000),
				emoji,
				message_id: reaction.message.id,
				user_id: user.id,
			});
		});
		Sentry.logger.info("Reaction saved in database");
	}

	@traced("event.handler")
	async #handleReactionDelete(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	) {
		const emoji = reaction.emoji.id ?? reaction.emoji.name;
		if (!emoji) {
			throw new Error("Reaction has no emoji ID or name");
		}
		await this.#db.query("delete reaction", async (tx) => {
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
	}

	@traced("event.handler")
	async #handleMemberJoinOrUpdate(member: GuildMember) {
		const record = {
			id: member.id,
			display_name: member.displayName,
			username: member.user.username,
		};
		this.#db.query("upsert member", (tx) =>
			tx.insert(membersTable).values(record).onConflictDoUpdate({
				target: membersTable.id,
				set: record,
			}),
		);
		Sentry.logger.info("Member saved in database", {
			"discord.user.id": member.id,
		});
	}

	@traced()
	async #upsertAllMembers(discord: DiscordService) {
		const guild = await discord.client.guilds.fetch(Guilds.Egrass);
		const members = await guild.members.fetch();
		this.#db.query("upsert all members", async (tx) => {
			for (const member of members.values()) {
				const record = {
					id: member.id,
					display_name: member.displayName,
					username: member.user.username,
				};
				this.#db.query("upsert member", (tx) =>
					tx.insert(membersTable).values(record).onConflictDoUpdate({
						target: membersTable.id,
						set: record,
					}),
				);
			}
		});
		Sentry.logger.info(Sentry.logger.fmt`${members.size} members saved in database`);
	}
}
