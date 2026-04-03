import { Events, type Client, type Message } from "discord.js";
import { env } from "../../env";
import { ChannelCategories, Users } from "../../consts";
import { extractMessageContext, withSentryEventScope } from "../../logging";

let enabled = true;

export function register(client: Client<true>) {
	if (env.DISABLE_LOCK_IN) {
		return;
	}

	client.on(
		Events.MessageCreate,
		withSentryEventScope("lock-in", async (message: Message) => {
			if (
				enabled &&
				message.author.id === Users.Sophia &&
				message.inGuild() &&
				message.channel.parentId !== ChannelCategories.Classes &&
				Math.random() < 0.2
			) {
				const sentMsg = await message.reply("AAAAAAAAAAAAAAH");
				sentMsg
					.awaitReactions({
						filter: (reaction) => reaction.emoji.name === "🤫",
						max: 1,
						idle: 600_000, // 10 minutes
					})
					.then((reactions) => {
						if (reactions.size > 0) {
							sentMsg.react("🤫");
							enabled = false;
							setTimeout(() => {
								enabled = true;
							}, 600_000); // 10 minutes
						}
					});
			}
		}, extractMessageContext),
	);
}
