import * as Sentry from "@sentry/bun";

import { Feature } from "../utils/service";
import type { EnvService } from "./env";
import type { DiscordService } from "./discord";
import {
	channelLink,
	MessageReferenceType,
	userMention,
	type Message,
	type OmitPartialGroupDMChannel,
	type PartialMessage,
} from "discord.js";
import { Guilds, Users } from "../consts";
import { traced } from "../utils/tracing";

enum NotificationType {
	DM,
	Ping,
}

interface Trigger {
	pattern: RegExp;
	user: Users;
	type: NotificationType;
}

export class KeywordNotificationService extends Feature {
	static readonly Triggers: Trigger[] = [
		{
			pattern: /\b(kian|kasad)\b/i,
			user: Users.Kian,
			type: NotificationType.DM,
		},
		{
			pattern: /\b(discord\s*mod|cailey)\b/i,
			user: Users.Cailey,
			type: NotificationType.Ping,
		},
	];

	#discord: DiscordService;

	constructor(env: EnvService, discord: DiscordService) {
		super(env);
		this.#discord = discord;
		if (this.isEnabled()) {
			discord.subscribe("message:create", (message) => this.#handleNewMessage(message));
			discord.subscribe("message:edit", (oldMsg, newMsg) =>
				this.#handleEditedMessage(oldMsg, newMsg),
			);
			Sentry.logger.info(`${this._name} initialized`);
		} else {
			Sentry.logger.info(`${this._name} disabled`);
		}
	}

	#getUsersToNotify(message: Message): Map<Users, Set<NotificationType>> {
		if (message.author.bot || message.guildId !== Guilds.Egrass) {
			return new Map();
		}

		const result = new Map<Users, Set<NotificationType>>();
		const getOrInsert = <K, V>(map: Map<K, V>, key: K, val: V) => {
			if (!map.has(key)) {
				map.set(key, val);
			}
			return map.get(key)!;
		};

		for (const { pattern, user, type } of KeywordNotificationService.Triggers) {
			// Don't notify users about their own messages
			if (message.author.id === user) continue;

			// Don't notify users if the message already mentions them
			if (message.mentions.users.has(user)) continue;

			// Check content
			if (pattern.test(message.content)) {
				getOrInsert(result, user, new Set()).add(type);
			}
			// Check forwarded message content
			else if (message.reference?.type === MessageReferenceType.Forward) {
				const snapshot = message.messageSnapshots.get(message.reference.messageId!)!;
				if (pattern.test(snapshot.content)) {
					getOrInsert(result, user, new Set()).add(type);
				}
			}
		}

		return result;
	}

	@traced("event.handler")
	async #handleNewMessage(message: OmitPartialGroupDMChannel<Message>) {
		const users = this.#getUsersToNotify(message);
		if (users.size > 0) {
			await this.#notifyUsers(users, message);
		}
	}

	@traced("event.handler")
	async #handleEditedMessage(
		oldMessage: OmitPartialGroupDMChannel<Message | PartialMessage>,
		newMessage: OmitPartialGroupDMChannel<Message>,
	) {
		if (oldMessage.partial) {
			oldMessage = await oldMessage.fetch();
		}

		if (!this.#getUsersToNotify(oldMessage)) {
			await this.#handleNewMessage(newMessage);
		}
	}

	@traced()
	async #notifyUsers(
		users: Map<Users, Set<NotificationType>>,
		message: OmitPartialGroupDMChannel<Message>,
	) {
		const notifications = users
			.entries()
			.flatMap(([user, types]) =>
				types.values().map<[Users, NotificationType]>((type) => [user, type]),
			);
		const handlers: Record<NotificationType, (user: Users) => Promise<void>> = {
			[NotificationType.DM]: async (user) => {
				await this.#discord.sendDM(
					user,
					`${userMention(message.author.id)} mentioned you in ${channelLink(message.channel.id, message.guildId!)}`,
				);
				await this.#discord.sendDM(user, {
					forward: { message },
				});
			},
			[NotificationType.Ping]: async (user) => {
				await message.reply({
					content: `Looks like someone mentioned you, ${userMention(user)}`,
					allowedMentions: { users: [user] },
				});
			},
		};
		await Promise.all(
			notifications.map(async ([user, type]) => {
				await handlers[type](user);
				Sentry.logger.info("Keyword notification sent", {
					"message.id": message.id,
					"user.id": message.author.id,
					"destination.user.id": user,
					"notification.type": NotificationType[type],
				});
			}),
		);
	}
}
