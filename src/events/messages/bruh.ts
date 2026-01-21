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
		message.content.match(
			/(?:\b(?:6+|six)\b.*\b(?:7+|seven)\b)|(?:\b6+7+\b)/i,
		)
	) {
		await message.react("🥀");
		await message.reply(
			Math.random() < 0.01
				? "https://tenor.com/view/bee-movie-layton-t-montgomery-monty-montgomery-67-6-7-gif-9758470031245276788"
				: "OMG HAHA SO FUNNY SIX AND SEVEN ARE CONSECUTIVE DIGITS 🤯",
		);
	}
}
