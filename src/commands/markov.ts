import {
	ChatInputCommandInteraction,
	Message,
	MessageFlags,
	SlashCommandBuilder,
	type GuildTextBasedChannel,
} from "discord.js";
import { Guilds, Users } from "../consts";
import { retrainModel } from "../markov";
import { createMessage, doInTransaction } from "../db";

enum Subcommands {
	Retrain = "retrain",
	Fetch = "fetch-messages",
}

export const data = new SlashCommandBuilder()
	.setName("markov")
	.setDescription("Manage the Markov model")
	.addSubcommand((sub) =>
		sub
			.setName(Subcommands.Retrain)
			.setDescription(
				"Retrain the Markov model using all messages in the database",
			),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommands.Fetch)
			.setDescription("Fetch all message in the server"),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	if (interaction.user.id !== Users.Kian) {
		await interaction.reply({
			content: "⛔️ You are not authorized to use this command",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const subcommand = interaction.options.getSubcommand();
	try {
		switch (subcommand) {
			case Subcommands.Retrain:
				await retrain(interaction);
				break;
			case Subcommands.Fetch:
				await fetchMessages(interaction);
				break;
		}
	} catch (error) {
		if (error instanceof Error) {
			await interaction.editReply({
				content: `⚠️ Error: ${error.message}`,
			});
		}
	}
}

async function retrain(interaction: ChatInputCommandInteraction) {
	await interaction.deferReply({
		flags: MessageFlags.Ephemeral,
	});
	await retrainModel(interaction.client);
	await interaction.editReply({
		content: "✅ Model retrained",
	});
}

async function fetchMessages(interaction: ChatInputCommandInteraction) {
	console.log("Fetching entire message history");
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const guild = await interaction.client.guilds.fetch(Guilds.Egrass);
	const channels = await guild.channels.fetch();
	const createMessageBatch = doInTransaction(
		(batch: Iterable<Message<true>>) => {
			let rowsInserted = 0;
			for (const message of batch) {
				rowsInserted += createMessage(message, true).changes;
			}
			return rowsInserted;
		},
	);
	const counter = {
		fetched: 0,
		inserted: 0,
	};
	const sendProgressUpdate = async () => {
		const msg = `⏳ Fetched ${counter.fetched}, inserted ${counter.inserted} messages so far...`;
		console.debug(msg);
		await interaction.editReply({
			content: msg,
		});
	};
	const interval = setInterval(sendProgressUpdate, 5000);
	await Promise.all(
		channels
			.values()
			.filter((channel) => channel?.isTextBased())
			.map(async (channel_) => {
				const channel = channel_ as GuildTextBasedChannel;
				let earliestMessageId: string | undefined;
				while (true) {
					const batch = await channel.messages.fetch({
						before: earliestMessageId,
						limit: 100, // Max allowed by API
					});
					if (batch.size === 0) return;
					counter.fetched += batch.size;
					counter.inserted += createMessageBatch(batch.values());
					// Batch is ordered youngest to oldest
					earliestMessageId = batch.at(-1)!.id;
				}
			}),
	);
	clearInterval(interval);
	const msg = `✅ Fetched ${counter.fetched}, inserted ${counter.inserted} messages`;
	console.log(msg);
	await interaction.editReply({
		content: msg,
	});
}
