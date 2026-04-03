import { Events, formatEmoji, userMention, type Client } from "discord.js";
import { Emoji, Users } from "../../consts";
import { extractMessageContext, withSentryEventScope } from "../../logging";

export function register(client: Client<true>) {
	const regex = new RegExp(`^${userMention(client.user.id)}\\s+explode\\b`);
	client.on(Events.MessageCreate, withSentryEventScope("explode", async (message) => {
		if (message.author.id === Users.Kian && regex.test(message.content)) {
			message.reply(`If I must... ${formatEmoji(Emoji.Sad)}`);
			throw new Error("It appears I have exploded", { cause: message });
		}
	}, extractMessageContext));
}
