import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { CannotExtrapolate, generateSentence } from "../markov";

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
			if (error instanceof CannotExtrapolate) {
				if (error.prompt === "") {
					const targetStr =
						target !== null
							? `@${interaction.guild?.members.cache.get(target.id)?.displayName} (${target.id})`
							: "null";
					console.warn(
						`Failed to extrapolate empty prompt; target = ${targetStr}`,
					);
				}
			} else {
				console.error(error);
			}
			await interaction.reply({
				content: `⚠️ Error generating message: ${error.message}`,
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
