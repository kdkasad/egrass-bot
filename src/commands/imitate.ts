import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { generateSentence } from "../markov";

export const data = new SlashCommandBuilder()
	.setName("imitate")
	.setDescription("Imitate a server member using the Markov model")
	.addUserOption((option) =>
		option
			.setName("user")
			.setDescription("User to imitate (optional)")
			.setRequired(false),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	const target = interaction.options.getUser("user");
	try {
		const sentence = generateSentence(target?.id);
		if (sentence.length > 0) {
			await interaction.reply({
				content: sentence,
				allowedMentions: { parse: [] },
			});
		} else {
			await interaction.reply({
				content:
					"⚠️ Unable to generate a sentence for the requested user",
				flags: MessageFlags.Ephemeral,
			});
		}
	} catch (error) {
		console.error(error);
	}
}
