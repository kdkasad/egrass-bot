// Handles the interaction created when the button is pressed on the Egrass Wrapped announcement

import {
	channelMention,
	Events,
	MessageFlags,
	time,
	TimestampStyles,
	type Client,
	type Interaction,
} from "discord.js";
import { getRecapStats, type RecapStats } from "../../db";
import { log } from "../../logging";
import { Channels } from "../../consts";

export function register(client: Client<true>) {
	client.on(Events.InteractionCreate, async (interaction) => {
		try {
			handleInteraction(interaction);
		} catch (error) {
			log.error("Error processing getRecap interaction", error);
			if (interaction.isRepliable() && error instanceof Error) {
				if (interaction.deferred || interaction.replied) {
					await interaction.editReply({
						content: `Error: ${error.message}`,
					});
				} else {
					await interaction.reply({
						content: `Error: ${error.message}`,
						flags: MessageFlags.Ephemeral,
					});
				}
			}
		}
	});
}

async function handleInteraction(interaction: Interaction) {
	if (!interaction.isButton()) return;
	if (interaction.customId !== "getRecap") return;

	log.info("Recap requested", {
		userId: interaction.user.id,
		displayName: interaction.user.displayName,
	});

	// Get the year to analyze from the date of the message containing the
	// button.
	const year = interaction.message.createdAt.getFullYear();

	// Send initial loading response
	const deferReply = interaction.deferReply({
		flags: MessageFlags.Ephemeral,
	});

	const stats = getRecapStats(year, interaction.user);
	const dmChannel = await interaction.user.createDM();
	await dmChannel.send({
		content: formatRecapStats(stats),
	});

	await deferReply;
	await interaction.editReply({
		content: `Check your DMs!`,
	});
}

function formatRecapStats(stats: RecapStats): string {
	const lines = [];
	lines.push("# 2025 Egrass Wrapped 🎁");
	lines.push("");
	lines.push("");

	lines.push(
		`- You sent 💬 ${stats.messagesSent.toLocaleString()} messages this year, ` +
			`putting you in 🏅 ${formatOrdinal(stats.rank)} place.`,
	);

	if (stats.mostMessagesDay !== null) {
		const date = new Date(stats.mostMessagesDay.timestamp);
		date.setHours(0, 0, 0, 0);
		const dateStr = time(date, TimestampStyles.LongDate);
		const countStr = stats.mostMessagesDay.count.toLocaleString();
		lines.push(
			`- Your most active day was 📅 ${dateStr}, during which you sent 💬 ${countStr} messages.`,
		);
	}

	if (stats.starboardMessages > 0) {
		lines.push(
			`- 🌟 ${stats.starboardMessages.toLocaleString()} of your ` +
				`messages made it to the ${channelMention(Channels.Starboard)}!`,
		);
	}
	lines.push("");

	if (stats.topEmojis.length > 0) {
		lines.push(`- Your top emojis:* ` + stats.topEmojis.join(" "));
	}
	if (stats.topChannels.length > 0) {
		lines.push(
			`- Your top ${stats.topChannels.length} channels this year:`,
		);
		for (const [i, channelId] of stats.topChannels.entries()) {
			lines.push(`  ${i + 1}. ${channelMention(channelId)}`);
		}
	}

	lines.push("");
	if (stats.neetcode.solves > 0) {
		lines.push(`- 💻 Neetcode solves:`);
		lines.push(`  - ✅ Solves: ${stats.neetcode.solves}`);
		lines.push(`  - 🥇 First solves: ${stats.neetcode.firstSolves}`);
		lines.push(
			`  - 📅 Longest daily streak: ${stats.neetcode.longestStreak} day${stats.neetcode.longestStreak === 1 ? "" : "s"}`,
		);
	}

	lines.push("");
	lines.push("-# \\* Only counts emojis sent in messages, not in reactions.");

	return lines.join("\n");
}

function formatOrdinal(n: number): string {
	const ordinalRules = new Intl.PluralRules(undefined, { type: "ordinal" });
	const ordinalToSuffix = {
		zero: "",
		many: "",
		one: "st",
		two: "nd",
		few: "rd",
		other: "th",
	};
	return n.toLocaleString() + ordinalToSuffix[ordinalRules.select(n)];
}
