import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { z } from "zod/mini";
import type { CommandHandler } from ".";

enum Subcommand {
	Set = "set",
}

const handlers: { [key in Subcommand]: CommandHandler } = {
	[Subcommand.Set]: executeSet,
};

const data = new SlashCommandBuilder()
	.setName("neetcode")
	.setDescription("Manage the Neetcode bot")
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Set)
			.setDescription("Set tomorrow's problems")
			.addStringOption((option) =>
				option
					.setName("url1")
					.setDescription("URL of the first Neetcode problem")
					.setRequired(true),
			)
			.addStringOption((option) =>
				option
					.setName("url2")
					.setDescription("URL of the second Neetcode problem")
					.setRequired(true),
			),
	);

async function execute(interaction: ChatInputCommandInteraction) {
	const parse = z
		.enum(Subcommand)
		.safeParse(interaction.options.getSubcommand());
	if (parse.success) {
		// Call the appropriate handler
		const subcommand = parse.data;
		await handlers[subcommand](interaction);
	} else {
		await interaction.reply({
			content: "Invalid subcommand. How did you even get here?",
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function executeSet(interaction: ChatInputCommandInteraction) {
	const url1 = interaction.options.getString("url1", true);
	const url2 = interaction.options.getString("url2", true);
	await interaction.reply({
		content: "Done!",
		flags: MessageFlags.Ephemeral,
	});
}

export { data, execute };
