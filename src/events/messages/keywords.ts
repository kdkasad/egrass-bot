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
import {
	extractMessageContext,
	extractMessageUpdateContext,
	log,
	withSentryEventScope,
} from "../../logging";

export function register(client: Client<true>) {
	client.on(Events.MessageCreate, withSentryEventScope("keywords", onNewMessage, extractMessageContext));
	client.on(Events.MessageUpdate, withSentryEventScope("keywords", onEditedMessage, extractMessageUpdateContext));
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
		message.reference?.type === MessageReferenceType.Forward &&
		message.reference.messageId &&
		message.messageSnapshots.has(message.reference.messageId)
	) {
		const snapshot = message.messageSnapshots.get(
			message.reference.messageId,
		)!;
		return pattern.test(snapshot.content);
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
