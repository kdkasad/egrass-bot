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

export function register(client: Client<true>) {
	client.on(Events.MessageReactionAdd, (reaction, user) => {
		addHandler(reaction, user);
	});
	client.on(Events.MessageReactionRemove, (reaction, user) => {
		removeHandler(reaction, user);
	});
}

async function addHandler(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
) {
	if (reaction.emoji.name !== "✅") return;
	if (!isPastAnnouncement(reaction.message.id)) return;

	console.log("Recording solve from ✅ reaction");
	const isFirstSolve = recordSolve(user, reaction.message);

	if (isFirstSolve) {
		const message = await reaction.message.fetch();
		console.log("First solve recorded");
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

	console.log("Removing solve because of ✅ reaction removal");
	const firstSolveUpdate = deleteSolve(user, reaction.message);
	if (!firstSolveUpdate.changed) return;

	const message = await reaction.message.fetch();
	if (firstSolveUpdate.userId) {
		console.debug("Updating first solve");
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
		console.debug("Removing first solve");
		await message.edit({
			content: message.content.replace(/\s*\n.* First solve: .*$/, ""),
		});
	}
}
