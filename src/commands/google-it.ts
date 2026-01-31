import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import * as Sentry from "@sentry/bun";
import { Channels } from "../consts";

export const data = new SlashCommandBuilder()
	.setName("google-it")
	.setDescription("RTFM");

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

			await interaction.channel.send({
				content: `https://www.google.com/search?q=${encodeURIComponent(interaction.channel.lastMessage.content)}`,
				flags: MessageFlags.SuppressNotifications,
			});
			await interaction.reply({
				content: "Sent!",
				flags: MessageFlags.Ephemeral,
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
