import {
	Events,
	MessageReaction,
	User,
	userMention,
	type Client,
	type PartialMessageReaction,
	type PartialUser,
} from "discord.js";
import { deleteSolve, isPastAnnouncement, recordSolve } from "../../db";
import { extractReactionContext, log, withSentryEventScope } from "../../logging";

export function register(client: Client<true>) {
	client.on(Events.MessageReactionAdd, withSentryEventScope("solves", addHandler, extractReactionContext));
	client.on(Events.MessageReactionRemove, withSentryEventScope("solves", removeHandler, extractReactionContext));
}

async function addHandler(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
) {
	if (reaction.emoji.name !== "✅") return;
	if (!isPastAnnouncement(reaction.message.id)) return;

	log.info("Recording solve from ✅ reaction", { user: user.displayName });
	const isFirstSolve = recordSolve(user, reaction.message);

	if (isFirstSolve) {
		const message = await reaction.message.fetch();
		log.info("First solve recorded");
		await message.edit({
			content: `${message.content}

🥇 First solve: ${user}`,
			allowedMentions: {
				parse: ["users"],
			},
		});
	}
}

async function removeHandler(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
) {
	if (reaction.emoji.name !== "✅") return;
	if (!isPastAnnouncement(reaction.message.id)) return;

	log.info("Removing solve because of ✅ reaction removal");
	const firstSolveUpdate = deleteSolve(user, reaction.message);
	if (!firstSolveUpdate.changed) return;

	const message = await reaction.message.fetch();
	if (firstSolveUpdate.userId) {
		log.debug("Updating first solve");
		await message.edit({
			content: message.content.replace(
				/First solve: .*$/,
				`First solve: ${userMention(firstSolveUpdate.userId)}`,
			),
			allowedMentions: {
				parse: ["users"],
			},
		});
	} else {
		log.debug("Removing first solve");
		await message.edit({
			content: message.content.replace(/\s*\n.* First solve: .*$/, ""),
		});
	}
}
