import { captureException } from "@sentry/bun";
import {
	ApplicationCommandType,
	ContextMenuCommandBuilder,
	Events,
	MessageFlags,
	type Client,
} from "discord.js";
import { log } from "../../logging";

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

	client.on(Events.InteractionCreate, async (interaction) => {
		if (
			interaction.isMessageContextMenuCommand() &&
			interaction.commandName == command.name
		) {
			try {
				await Promise.all(
					NO_REACTIONS.map((emoji) =>
						interaction.targetMessage.react(emoji),
					),
				);
				await interaction.reply({
					content: "✅",
					flags: MessageFlags.Ephemeral,
				});
			} catch (error) {
				if (error instanceof Error) {
					captureException(error, {
						extra: { messageId: interaction.targetMessage.id },
					});
					log.error(`Error reacting to message: ${error.message}`, error);
					await interaction.reply({
						content: `Error: ${error.message}`,
						flags: MessageFlags.Ephemeral,
					});
				}
			}
		}
	});
}
