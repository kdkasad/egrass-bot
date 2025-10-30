import {
	ChatInputCommandInteraction,
	MessageFlags,
	messageLink,
	SlashCommandBuilder,
} from "discord.js";
import { getRandomQuoteInCategory } from "../db";
import { QuoteCategories, Stickers } from "../consts";

export const data = new SlashCommandBuilder()
	.setName("freak")
	.setDescription("Obtain words of wisdom from the freak himself");

export async function execute(interaction: ChatInputCommandInteraction) {
	const quote = getRandomQuoteInCategory(QuoteCategories.Atharva);
	if (quote) {
		await interaction.deferReply({
			flags: MessageFlags.Ephemeral,
		});
		const channel = await interaction.channel?.fetch();
		if (!channel || !channel.isSendable()) return;
		await channel.send({
			content: `${quote.quote} (${messageLink(quote.channel_id, quote.message_id, quote.guild_id)})`,
			stickers: [Stickers.AtharvaSays],
		});
		await interaction.editReply({
			content: "Sent!",
		});
	} else {
		await interaction.reply({
			content: "No quotes available yet.",
			flags: MessageFlags.Ephemeral,
		});
	}
}
