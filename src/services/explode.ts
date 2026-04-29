import { Feature } from "../utils/service";
import { traced } from "../utils/tracing";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";
import { formatEmoji, userMention, type Message, type OmitPartialGroupDMChannel } from "discord.js";
import { Emoji, Users } from "../consts";

export class ExplodeService extends Feature {
	constructor(env: EnvService, discord: DiscordService) {
		super(env);
		discord.subscribe("message:create", (msg) => this.handleMessage(msg));
	}

	@traced("event.handler")
	private async handleMessage(message: OmitPartialGroupDMChannel<Message>) {
		const regex = new RegExp(`^${userMention(message.client.user.id)}\\s+explode\\b`);
		if (message.author.id === Users.Kian && regex.test(message.content)) {
			message.reply(`If I must... ${formatEmoji(Emoji.Sad)}`);
			throw new Error("It appears I have exploded", { cause: message });
		}
	}
}
