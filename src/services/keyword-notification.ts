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

export class KeywordNotificationService extends Feature {
	static #PATTERN = /\b(kian|kasad)\b/i;

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

	#test(message: Message): boolean {
		if (
			message.author.bot ||
			message.author.id === Users.Kian ||
			message.guildId !== Guilds.Egrass
		) {
			return false;
		}
		if (KeywordNotificationService.#PATTERN.test(message.content)) {
			return true;
		} else if (
			message.reference?.type === MessageReferenceType.Forward &&
			message.reference.messageId &&
			message.messageSnapshots.has(message.reference.messageId)
		) {
			const snapshot = message.messageSnapshots.get(message.reference.messageId)!;
			return KeywordNotificationService.#PATTERN.test(snapshot.content);
		}
		return false;
	}

	@traced("event.handler")
	async #handleNewMessage(message: OmitPartialGroupDMChannel<Message>) {
		if (this.#test(message)) {
			await this.#discord.sendDM(
				Users.Kian,
				`${userMention(message.author.id)} mentioned you in ${channelLink(message.channel.id, message.guildId!)}`,
			);
			await this.#discord.sendDM(Users.Kian, {
				forward: { message },
			});
			Sentry.logger.info("Keyword notification sent", {
				"message.id": message.id,
				"user.id": message.author.id,
				"destination.user.id": Users.Kian,
			});
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
		if (!this.#test(oldMessage)) {
			await this.#handleNewMessage(newMessage);
		}
	}
}
