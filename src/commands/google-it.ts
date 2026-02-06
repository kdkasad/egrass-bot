import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import * as Sentry from "@sentry/bun";
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
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	await Sentry.withIsolationScope(async (scope) => {
		scope.setUser({
			id: interaction.user.id,
			username: interaction.user.username,
		});
		scope.setContext("discord.interaction", {
			id: interaction.id,
			guild: interaction.guildId,
			channel: interaction.channelId,
			timestamp: interaction.createdAt,
			user: interaction.user.id,
			arguments: interaction.options,
		});

		if (!interaction.inGuild()) {
			await interaction.reply({
				content: "This command must be run in a server",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		try {
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

			const queryArg = interaction.options.getString("query")?.trim();
			const query =
				queryArg && queryArg.length > 0
					? queryArg
					: interaction.channel.lastMessage.content.trim();

			await interaction.reply({
				content: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
				flags: MessageFlags.SuppressNotifications,
			});
		} catch (error) {
			Sentry.captureException(error);
			await interaction.reply({
				content: `Error: ${(error as Error).message}`,
				flags: MessageFlags.Ephemeral,
			});
		}
	});
}
