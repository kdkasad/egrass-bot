import {
	ChatInputCommandInteraction,
	Message,
	MessageFlags,
	SlashCommandBuilder,
	type GuildTextBasedChannel,
} from "discord.js";
import { Guilds, Users } from "../consts";
import { createMessage, doInTransaction } from "../db";
import { log } from "../logging";

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

	// Create worker to do training so we don't block the event loop
	log.info("Dispatching worker for Markov retraining");
	const worker = new Worker(
		new URL("../workers/retrain.ts", import.meta.url),
	);

	// Send the worker the set of bot users since it doesn't have a Discord client
	const members = await interaction.guild!.members.fetch();
	const botUserIds = new Set(
		members
			.values()
			.filter((member) => member.user.bot)
			.map((member) => member.id),
	);
	worker.postMessage(botUserIds);

	// Promise that resolves when the worker exits
	const workerExited = new Promise<void>((resolve) => {
		worker.addEventListener("close", () => resolve());
	});

	// Track the count of messages processed, updated by messages sent from the worker
	let count = 0;
	worker.addEventListener("message", (event) => {
		count = event.data as number;
	});

	// Send progress updates to the calling user every 2 seconds
	const interval = setInterval(() => {
		interaction.editReply({
			content: `⏳ Processed ${count} messages...`,
		});
	}, 2000);

	// Wait until the worker exits
	await workerExited;
	log.info("Retraining worker exited");

	// Stop sending progress updates
	clearInterval(interval);

	// Send final progress update message
	await interaction.editReply({
		content: `✅ Model retrained; processed ${count} messages`,
	});
}

async function fetchMessages(interaction: ChatInputCommandInteraction) {
	log.info("Fetching entire message history");
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
		log.debug(msg);
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
	log.info("Finished fetching messages", counter);
	await interaction.editReply({
		content: `✅ Fetched ${counter.fetched}, inserted ${counter.inserted} messages`,
	});
}
