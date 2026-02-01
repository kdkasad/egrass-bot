import { Events, type Client, type Message } from "discord.js";
import { env } from "../../env";

export function register(client: Client<true>) {
	if (env.DISABLE_TROLLING) {
		return;
	}

	client.on(Events.MessageCreate, async (message: Message) => {
		if (message.author.bot) {
			return;
		}

		if (message.author.username === "soviet.sofa" && Math.random() < 0.2) {
			await message.channel.send("AAAAAAAAAAAAAAH");
		}
	});
}
