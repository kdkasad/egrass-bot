import type {
	Client,
	Message,
	OmitPartialGroupDMChannel,
	PartialMessage,
} from "discord.js";
import {
	createMessage,
	deleteMarkovEntries,
	deleteMessage,
	doInTransaction,
} from "../../db";
import { addMessageToMarkov4 } from "../../markov";

export function register(client: Client<true>) {
	client.on("messageCreate", (message) => {
		return handlerCreate(message);
	});
	client.on("messageDelete", (message) => {
		return handlerDelete(message);
	});
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

const deleteMessageAndEntriesTransaction = doInTransaction(
	(message: Message<true>) => {
		deleteMessage(message);
		if (!message.author.bot) {
			deleteMarkovEntries(message.id);
		}
	},
);

async function handlerDelete(
	message: OmitPartialGroupDMChannel<Message> | PartialMessage,
) {
	if (!message.inGuild() || message.member === null) return;
	deleteMessageAndEntriesTransaction(message);
}
