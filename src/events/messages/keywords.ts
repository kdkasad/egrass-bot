import {
	Events,
	Message,
	MessageReferenceType,
	type Client,
	type OmitPartialGroupDMChannel,
	type PartialMessage,
} from "discord.js";
import { Users } from "../../consts";

export function register(client: Client<true>) {
	client.on(Events.MessageCreate, onNewMessage);
	client.on(Events.MessageUpdate, onEditedMessage);
}

async function test(
	message: Message,
	followReference: boolean = true,
): Promise<boolean> {
	const pattern = /\bkian\b/i;
	if (
		!message.author.bot &&
		message.author.id !== Users.Kian &&
		message.content.match(pattern) !== null
	) {
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
		dm.send(`${message.member!.displayName} mentioned you: ${message.url}`);
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
