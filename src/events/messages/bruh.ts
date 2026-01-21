import { Events, Message, type Client } from "discord.js";
import { env } from "../../env";

export function register(client: Client<true>) {
	if (!env.DISABLE_TROLLING) {
		client.on(Events.MessageCreate, handleMessage);
	}
}

async function handleMessage(message: Message) {
	if (
		!message.author.bot &&
		message.content.match(/(?:\b6+\b.*\b7+\b)|(?:\b6+7+\b)/)
	) {
		await message.react("🥀");
		await message.reply(
			"OMG HAHA SO FUNNY SIX AND SEVEN ARE CONSECUTIVE DIGITS 🤯",
		);
	}
}
