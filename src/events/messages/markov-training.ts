import type { Client, Message, OmitPartialGroupDMChannel } from "discord.js";
import { createMessage, doInTransaction } from "../../db";
import { addMessageToMarkov4 } from "../../markov";

export function register(client: Client<true>) {
	client.on("messageCreate", (message) => {
		return handler(message);
	});
}

const saveAndTrainOnMessageTransaction = doInTransaction(
	(message: Message<true>) => {
		createMessage(message);
		addMessageToMarkov4(message);
	},
);

async function handler(message: OmitPartialGroupDMChannel<Message>) {
	if (!message.inGuild() || message.member === null) return;
	saveAndTrainOnMessageTransaction(message);
}
