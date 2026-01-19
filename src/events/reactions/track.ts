import {
	Events,
	MessageReaction,
	User,
	type Client,
	type PartialMessageReaction,
	type PartialUser,
} from "discord.js";
import { addReaction, removeReaction } from "../../db";
import { log } from "../../logging";

export function register(client: Client<true>) {
	client.on(Events.MessageReactionAdd, (reaction, user) => {
		addReactionHandler(reaction, user);
	});
	client.on(Events.MessageReactionRemove, (reaction, user) => {
		removeReactionHandler(reaction, user);
	});
}

async function addReactionHandler(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
) {
	if (reaction.partial) {
		reaction = await reaction.fetch();
	}
	if (user.partial) {
		user = await user.fetch();
	}
	log.debug("Reaction added", {
		message_id: reaction.message.id,
		user_id: user.id,
		emoji: reaction.emoji.id ?? reaction.emoji.name,
	});
	addReaction(reaction, user);
}

async function removeReactionHandler(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
) {
	if (reaction.partial) {
		reaction = await reaction.fetch();
	}
	if (user.partial) {
		user = await user.fetch();
	}
	log.debug("Reaction removed", {
		message_id: reaction.message.id,
		user_id: user.id,
		emoji: reaction.emoji.id ?? reaction.emoji.name,
	});
	const changes = removeReaction(reaction, user);
	if (changes.changes !== 1) {
		log.warn("Reaction removal: unexpected number of rows changed", {
			expected: 1,
			changed: changes.changes,
		});
	}
}
