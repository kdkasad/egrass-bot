import {
	channelLink,
	Events,
	Message,
	MessageReferenceType,
	userMention,
	type Client,
	type OmitPartialGroupDMChannel,
	type PartialMessage,
} from "discord.js";
import { Guilds, Users } from "../../consts";
import { log } from "../../logging";
import * as Sentry from "@sentry/bun";

export function register(client: Client<true>) {
	client.on(Events.MessageCreate, (message) =>
		Sentry.withIsolationScope(async () => {
			Sentry.setContext(
				"message",
				message as unknown as Record<string, unknown>,
			);
			return await onNewMessage(message);
		}),
	);
	client.on(Events.MessageUpdate, (oldMessage, newMessage) =>
		Sentry.withIsolationScope(async () => {
			Sentry.setContext(
				"oldMessage",
				oldMessage as unknown as Record<string, unknown>,
			);
			Sentry.setContext(
				"newMessage",
				newMessage as unknown as Record<string, unknown>,
			);
			return await onEditedMessage(oldMessage, newMessage);
		}),
	);
}

async function test(
	message: Message,
	followReference: boolean = true,
): Promise<boolean> {
	const pattern = /\bkian\b/i;
	if (
		message.author.bot ||
		message.author.id === Users.Kian ||
		message.guildId !== Guilds.Egrass
	) {
		return false;
	}
	if (pattern.test(message.content)) {
		return true;
	} else if (
		followReference &&
		message.reference?.type === MessageReferenceType.Forward
	) {
		const ref = await message.fetchReference();
		return test(ref, false);
	}
	return false;
}

async function onNewMessage(message: Message) {
	if (await test(message)) {
		const client = message.client;
		const kian = await client.users.fetch(Users.Kian);
		const dm = await kian.createDM();
		await dm.send(
			`${userMention(message.author.id)} mentioned you in ${channelLink(message.channel.id)}`,
		);
		await dm.send({
			forward: { message },
		});
		log.debug("Keyword notification sent", {
			messageId: message.id,
			content: message.content,
		});
	}
}

async function onEditedMessage(
	oldMessage: OmitPartialGroupDMChannel<Message | PartialMessage>,
	newMessage: Message,
) {
	if (oldMessage.partial) {
		oldMessage = await oldMessage.fetch();
	}
	if (!(await test(oldMessage))) {
		onNewMessage(newMessage);
	}
}
