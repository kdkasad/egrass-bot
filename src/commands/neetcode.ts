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
	setProblemsForDay,
} from "../db";
import { formatProblemUrls, getDate } from "../utils";

enum Subcommand {
	Set = "set",
	Clear = "clear",
}

const handlers: { [key in Subcommand]: CommandHandler } = {
	[Subcommand.Set]: executeSet,
	[Subcommand.Clear]: executeClear,
};

const MAX_PROBLEMS = 5;

const daysFromTodayOptionFunc = (
	option: SlashCommandIntegerOption,
): SlashCommandIntegerOption =>
	option
		.setName("days-from-today")
		.setDescription(
			"Date to clear, as a number of days from today (0 = today, 1 = tomorrow, etc.). Default: tomorrow",
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
	);

async function execute(interaction: ChatInputCommandInteraction) {
	// Make sure it's Alex
	if (interaction.user.id !== Users.Alex) {
		await interaction.reply({
			content: "You are not French enough to use this command.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Dispatch to the right subcommand handler
	const parse = z
		.enum(Subcommand)
		.safeParse(interaction.options.getSubcommand());
	if (parse.success) {
		// Call the appropriate handler
		const subcommand = parse.data;
		await handlers[subcommand](interaction);
	} else {
		await interaction.reply({
			content: "Invalid subcommand. How did you even get here?",
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function executeSet(interaction: ChatInputCommandInteraction) {
	// Get problem list from command options
	let problems = [];
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
		setProblemsForDay(daysFromToday, problems);
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

export { data, execute };
