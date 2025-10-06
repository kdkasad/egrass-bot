import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonInteraction,
	ButtonStyle,
	ChatInputCommandInteraction,
	DiscordjsError,
	DiscordjsErrorCodes,
	MessageFlags,
	SlashCommandBuilder,
	SlashCommandIntegerOption,
	type CacheType,
} from "discord.js";
import { z } from "zod/mini";
import type { CommandHandler } from ".";
import { Users } from "../consts";
import {
	clearProblemsForDay,
	getProblemsForDay,
	getStats,
	listProblems,
	setProblemsForDay,
	UniquenessError,
} from "../db";
import { formatProblemUrls, getDate } from "../utils";
import { execute as triggerAnnounceJob } from "../jobs/announce";

enum Subcommand {
	Set = "set",
	Clear = "clear",
	List = "list",
	Announce = "announce",
	Stats = "stats",
}

const handlers: { [key in Subcommand]: CommandHandler } = {
	[Subcommand.Set]: executeSet,
	[Subcommand.Clear]: executeClear,
	[Subcommand.List]: executeList,
	[Subcommand.Announce]: executeAnnounce,
	[Subcommand.Stats]: executeStats,
};

const MAX_PROBLEMS = 5;

const daysFromTodayOptionFunc = (
	option: SlashCommandIntegerOption,
): SlashCommandIntegerOption =>
	option
		.setName("days-from-today")
		.setDescription(
			"Date to modify, as a number of days from today (0 = today, 1 = tomorrow, etc.). Default: tomorrow",
		)
		.setRequired(false);
const data = new SlashCommandBuilder()
	.setName("neetcode")
	.setDescription("Manage the Neetcode bot")
	.addSubcommand((sub) => {
		sub = sub
			.setName(Subcommand.Set)
			.setDescription("Set a day's problems");
		for (let i = 1; i <= MAX_PROBLEMS; i++) {
			sub = sub.addStringOption((option) =>
				option
					.setName(`url-${i}`)
					.setDescription(
						`URL of Neetcode problem #${i}` +
							(i == 1 ? "" : " (optional)"),
					)
					.setRequired(i == 1),
			);
		}
		return sub.addIntegerOption(daysFromTodayOptionFunc);
	})
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Clear)
			.setDescription("Clear the problems for the given day")
			.addIntegerOption(daysFromTodayOptionFunc),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.List)
			.setDescription("List each day's problems")
			.addBooleanOption((option) =>
				option
					.setName("include-past")
					.setDescription("Include days in the past. Default: false")
					.setRequired(false),
			),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Announce)
			.setDescription(
				"Manually trigger announcement of today's problems",
			),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Stats)
			.setDescription("Show a user's stats")
			.addUserOption((option) =>
				option
					.setName("user")
					.setDescription("The user to show stats for")
					.setRequired(false),
			),
	);

async function execute(interaction: ChatInputCommandInteraction) {
	// Dispatch to the right subcommand handler
	const parse = z
		.enum(Subcommand)
		.safeParse(interaction.options.getSubcommand());
	if (parse.success) {
		const subcommand = parse.data;

		// Check authorization
		const allowedUsers = [Users.Alex, Users.Kian] as string[];
		if (
			![Subcommand.Stats].includes(subcommand) &&
			!allowedUsers.includes(interaction.user.id)
		) {
			await interaction.reply({
				content: "You are not French enough to use this command.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Call the appropriate handler
		try {
			await handlers[subcommand](interaction);
		} catch (error) {
			console.error(
				`Error executing /${interaction.commandName} ${subcommand}`,
				error,
			);
		}
	} else {
		await interaction.reply({
			content: "Invalid subcommand. How did you even get here?",
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function executeSet(interaction: ChatInputCommandInteraction) {
	// Get problem list from command options
	const problems: string[] = [];
	for (let i = 1; i <= MAX_PROBLEMS; i++) {
		const url = interaction.options.getString(`url-${i}`, i == 1);
		if (!url) continue;
		problems.push(url);
	}
	const daysFromToday =
		interaction.options.getInteger("days-from-today") ?? 1;

	const date = new Date(getDate(daysFromToday) * 1000);
	const dateString = `${date.getMonth() + 1}/${date.getDate()}`;

	const commitAndGetResponseContent = () => {
		try {
			setProblemsForDay(daysFromToday, problems);
		} catch (error) {
			if (error instanceof UniquenessError) {
				return `Error: Problem <${error.problemUrl}> is already in the list`;
			}
			throw error;
		}
		return `Problems set for ${dateString}:\n${formatProblemUrls(getProblemsForDay(daysFromToday))}`;
	};

	try {
		// If problems are already set, confirm before overwriting
		const currentProblems = getProblemsForDay(daysFromToday);
		if (currentProblems.length > 0) {
			promptForConfirmation({
				interaction,
				promptContent: `The following problems are already set for ${dateString}:
${formatProblemUrls(currentProblems)}
Are you sure you want to overwrite them?`,
				onCancel: async (click) => {
					// If cancelled, update the initial response
					await click?.update({
						content: "Cancelled.",
						components: [],
					});
				},
				onConfirm: async (click) => {
					// If confirmed, commit the changes and update the initial response
					await click.update({
						content: commitAndGetResponseContent(),
						components: [],
					});
				},
			});
		} else {
			// If not overwriting already-set problems, commit the changes and reply to the command
			await interaction.reply({
				content: commitAndGetResponseContent(),
				flags: MessageFlags.Ephemeral,
			});
		}
	} catch (error) {
		await interaction.reply({
			content: "Failed to set problems.",
			flags: MessageFlags.Ephemeral,
		});
		console.error(`Error setting problems for ${dateString}`, error);
	}
}

async function promptForConfirmation({
	interaction,
	promptContent,
	onConfirm,
	onCancel,
}: {
	interaction: ChatInputCommandInteraction;
	promptContent: string;
	onConfirm: (click: ButtonInteraction<CacheType>) => Promise<void>;
	onCancel: (click: ButtonInteraction<CacheType> | null) => Promise<void>;
}) {
	// Send a response with a confirm and a cancel button
	const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId("cancel")
			.setLabel("Cancel")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId("confirm")
			.setLabel("Confirm")
			.setStyle(ButtonStyle.Danger),
	);
	const response = await interaction.reply({
		content: promptContent,
		flags: MessageFlags.Ephemeral,
		components: [buttonRow],
		withResponse: true,
	});

	// Wait for the button to be clicked
	try {
		const click = await response.resource?.message?.awaitMessageComponent({
			time: 60_000, // 1 minute
		});
		if (!click?.isButton()) {
			throw new Error("Unexpected interaction event received");
		}
		if (click.customId === "confirm") {
			await onConfirm(click);
		} else if (click?.customId === "cancel") {
			await onCancel(click);
		} else {
			throw new Error("Unexpected button click: id = " + click?.customId);
		}
	} catch (error) {
		if (
			error instanceof DiscordjsError &&
			error.code === DiscordjsErrorCodes.InteractionCollectorError
		) {
			// Timed out while waiting
			onCancel(null);
		} else {
			throw error;
		}
	}
}

async function executeClear(interaction: ChatInputCommandInteraction) {
	const daysFromToday =
		interaction.options.getInteger("days-from-today") ?? 1;
	const date = new Date(getDate(daysFromToday) * 1000);
	const dateString = `${date.getMonth() + 1}/${date.getDate()}`;

	const problems = getProblemsForDay(daysFromToday);
	if (problems.length > 0) {
		// Confirm before clearing
		promptForConfirmation({
			interaction,
			promptContent: `This will clear the following problems for ${dateString}:
${formatProblemUrls(problems)}
Continue?`,
			onCancel: async (click) => {
				await click?.update({
					content: "Cancelled.",
					components: [],
				});
			},
			onConfirm: async (click) => {
				clearProblemsForDay(daysFromToday);
				click.update({
					content: `Cleared ${problems.length} problems for ${dateString}`,
					components: [],
				});
			},
		});
	} else {
		// No problems to clear
		await interaction.reply({
			content: `No problems to clear for ${dateString}`,
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function executeList(interaction: ChatInputCommandInteraction) {
	const includePast = interaction.options.getBoolean("include-past") ?? false;
	const days = listProblems(includePast);
	if (days.size === 0) {
		await interaction.reply({
			content: "No problems found.",
			flags: MessageFlags.Ephemeral,
		});
	} else {
		let message = "";
		for (const [day, problems] of days) {
			const weekday = day.toLocaleDateString("en-US", {
				weekday: "long",
			});
			message += `### ${weekday}, ${day.getMonth() + 1}/${day.getDate()}\n`;
			message += formatProblemUrls(problems);
			message += "\n";
		}
		await interaction.reply({
			content: message.trim(),
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function executeAnnounce(interaction: ChatInputCommandInteraction) {
	// Tell Discord we're processing the command and will respond shortly
	await interaction.deferReply({
		flags: MessageFlags.Ephemeral,
	});
	let responseMsg = "Announcement sent.";
	try {
		await triggerAnnounceJob(interaction.client);
	} catch (error) {
		responseMsg = `Error sending announcement: ${(error as Error).message}.`;
	}
	// Finalize response
	await interaction.reply({
		content: responseMsg,
		flags: MessageFlags.Ephemeral,
	});
}

async function executeStats(interaction: ChatInputCommandInteraction) {
	const user = interaction.options.getUser("user") ?? interaction.user;
	const stats = getStats(user);
	await interaction.reply({
		content: `## Stats for ${user}
- ✅ Solves: ${stats.solves}
- 🥇 First solves: ${stats.firstSolves}
- 📆 Longest daily streak: ${stats.longestStreak}`,
		allowedMentions: { parse: ["users"] },
	});
}

export { data, execute };
