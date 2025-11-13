import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { generateSentence } from "../markov";

export const data = new SlashCommandBuilder()
	.setName("imitate")
	.setDescription("Imitate a server member using the Markov model")
	.addStringOption((option) =>
		option
			.setName("prompt")
			.setDescription("Text to start the message with")
			.setRequired(false),
	)
	.addUserOption((option) =>
		option
			.setName("user")
			.setDescription("User to imitate (optional)")
			.setRequired(false),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	const target = interaction.options.getUser("user");
	const prompt = interaction.options.getString("prompt") ?? "";
	try {
		const sentence = generateSentence(prompt, target?.id);
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
		if (error instanceof Error) {
			await interaction.reply({
				content: `⚠️ Error generating message: ${error.message}`,
				flags: MessageFlags.Ephemeral,
			});
		}
		console.error(error);
	}
}
