import {
	ApplicationCommandType,
	ContextMenuCommandBuilder,
	Events,
	MessageFlags,
	type Client,
} from "discord.js";
import { extractInteractionContext, withSentryEventScope } from "../../logging";

const NO_REACTIONS: string[] = [
	"❌",
	"🚫",
	"⛔",
	"👎",
	"🙅",
	"🙅‍♂️",
	"🙅‍♀️",
	"🙂‍↔️",
];

const command = new ContextMenuCommandBuilder()
	.setType(ApplicationCommandType.Message)
	.setName("Big no");

export async function register(client: Client<true>) {
	await Promise.all(
		client.guilds.cache.map((guild) => guild.commands.create(command)),
	);

	client.on(Events.InteractionCreate, withSentryEventScope("big-no", async (interaction) => {
		if (
			interaction.isMessageContextMenuCommand() &&
			interaction.commandName == command.name
		) {
			await Promise.all(
				NO_REACTIONS.map((emoji) =>
					interaction.targetMessage.react(emoji),
				),
			);
			await interaction.reply({
				content: "✅",
				flags: MessageFlags.Ephemeral,
			});
		}
	}, extractInteractionContext));
}
