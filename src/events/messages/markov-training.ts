import type {
	Client,
	Message,
	OmitPartialGroupDMChannel,
	PartialMessage,
} from "discord.js";
import { createMessage, deleteMessage, doInTransaction } from "../../db";
import { addMessageToMarkov4 } from "../../markov";
import { log } from "../../logging";

export function register(client: Client<true>) {
	client.on("messageCreate", handlerCreate);
	client.on("messageDelete", handlerDelete);
}

const saveAndTrainOnMessageTransaction = doInTransaction(
	(message: Message<true>) => {
		createMessage(message);
		if (!message.author.bot) {
			addMessageToMarkov4(message, message.author.id);
		}
	},
);

async function handlerCreate(message: OmitPartialGroupDMChannel<Message>) {
	if (!message.inGuild() || message.member === null) return;
	saveAndTrainOnMessageTransaction(message);
}

async function handlerDelete(
	message: OmitPartialGroupDMChannel<Message> | PartialMessage,
) {
	deleteMessage(message);
	log.debug("Message deleted", {
		id: message.id,
		author: message.author?.id,
	});
}
