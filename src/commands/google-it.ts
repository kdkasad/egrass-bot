import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { Channels } from "../consts";

export const data = new SlashCommandBuilder()
	.setName("google-it")
	.setDescription("RTFM")
	.addStringOption((option) =>
		option
			.setName("query")
			.setDescription(
				"Search query to use (defaults to last message's content if empty)",
			)
			.setRequired(false),
	)
	.addBooleanOption((option) =>
		option
			.setName("gpt-it")
			.setDescription("Generate ai slop instead")
			.setRequired(false),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	if (!interaction.inGuild()) {
		await interaction.reply({
			content: "This command must be run in a server",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!interaction.channel) {
		throw new Error("Channel is null");
	}
	if (
		interaction.channel.isThread()
			? interaction.channel.parentId === Channels.Announcements
			: interaction.channelId === Channels.Announcements
	) {
		return;
	}
	if (!interaction.channel.lastMessage) {
		throw new Error("Last message in channel is null");
	}

	let query = interaction.options.getString("query")?.trim();
	if (!query) {
		if (!interaction.channel.lastMessage) {
			await interaction.reply({
				content: "Last message in channel is null",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		query = interaction.channel.lastMessage.content.trim();
	}
	await interaction.reply({
		// also partially written by basant sharma
		content:
			(interaction.options.getBoolean("gpt-it") ?? false)
				? `https://www.chatgpt.com/?q=${encodeURIComponent(query)}`
				: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
		flags: MessageFlags.SuppressNotifications, // kurt wuz here
	});
}
