import {
	ButtonStyle,
	ChatInputCommandInteraction,
	MessageFlags,
	SectionBuilder,
	SlashCommandBuilder,
} from "discord.js";
import { Channels, Users } from "../consts";
import { log } from "../logging";

type Handler = (interaction: ChatInputCommandInteraction) => Promise<void>;

enum Subcommand {
	Trigger = "trigger",
}

const subcommandHandlers: Record<Subcommand, Handler> = {
	[Subcommand.Trigger]: handleTrigger,
};

export const data = new SlashCommandBuilder()
	.setName("recap")
	.setDescription("Commands related to Egrass Recap")
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Trigger)
			.setDescription("Send the recap announcement"),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	// Permission check
	if (interaction.user.id !== Users.Kian) {
		await interaction.reply({
			content: "⛔️ Permission denied",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Execute subcommand handler and catch errors
	const subcommand = interaction.options.getSubcommand() as Subcommand;
	try {
		await subcommandHandlers[subcommand](interaction);
	} catch (error) {
		log.error(`Error running /recap ${subcommand}`, error);
		await interaction.reply({
			content: `⚠️ Error: ${error instanceof Error ? error.message : error}`,
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function handleTrigger(interaction: ChatInputCommandInteraction) {
	const year = new Date().getFullYear();

	log.info("Sending recap announcement", { year });

	// Get and verify channel
	const channel =
		Bun.env.NODE_ENV === "production"
			? await interaction.client.channels.fetch(Channels.Announcements)
			: await interaction.client.users.createDM(Users.Kian);
	if (!channel) {
		throw new Error(`Failed to fetch announcement channel`);
	}
	if (!channel.isSendable()) {
		throw new Error(`Announcement channel is not sendable`);
	}

	// Send deferred response
	const defer = interaction.deferReply({
		flags: MessageFlags.Ephemeral,
	});

	// Build announcement
	const component = new SectionBuilder()
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(
				`# 🎁 Egrass Wrapped 🎁\n\nThe ${year} recap is in!`,
			),
		)
		.setButtonAccessory((btn) =>
			btn
				.setCustomId("getRecap")
				.setLabel("Send me mine!")
				.setStyle(ButtonStyle.Primary),
		);
	// Send announcement
	await channel.send({
		components: [component],
		flags: MessageFlags.IsComponentsV2,
	});

	// Ensure deferred response is sent before updating
	await defer;
	// Update with final message
	await interaction.editReply({
		content: `✅ Announcement sent`,
	});
}
