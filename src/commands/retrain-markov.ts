import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { Users } from "../consts";
import { clearMarkovModel, doInTransaction, getAllMessages } from "../db";
import { addMessageToMarkov4, retrainModel } from "../markov";

export const data = new SlashCommandBuilder()
	.setName("retrain-markov")
	.setDescription(
		"Retrain the Markov model using all messages in the database",
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	if (interaction.user.id !== Users.Kian) {
		await interaction.reply({
			content: "⛔️ You are not authorized to use this command",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({
		flags: MessageFlags.Ephemeral,
	});
	try {
		await retrainModel(interaction.client);
		await interaction.editReply({
			content: "✅ Model retrained",
		});
	} catch (error) {
		if (error instanceof Error) {
			await interaction.editReply({
				content: `⚠️ Error: ${error.message}`,
			});
		}
	}
}
