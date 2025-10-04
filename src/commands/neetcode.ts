import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChatInputCommandInteraction,
	DiscordjsError,
	DiscordjsErrorCodes,
	InteractionCallbackResponse,
	MessageFlags,
	MessagePayload,
	SlashCommandBuilder,
	type BooleanCache,
	type InteractionReplyOptions,
	type InteractionUpdateOptions,
} from "discord.js";
import { z } from "zod/mini";
import type { CommandHandler } from ".";
import { Users } from "../consts";
import { getProblemsForDay, setProblemsForDay } from "../db";
import { formatProblemUrls, getDate } from "../utils";

enum Subcommand {
	Set = "set",
}

const handlers: { [key in Subcommand]: CommandHandler } = {
	[Subcommand.Set]: executeSet,
};

const MAX_PROBLEMS = 5;

const data = new SlashCommandBuilder()
	.setName("neetcode")
	.setDescription("Manage the Neetcode bot")
	.addSubcommand((sub) => {
		sub = sub
			.setName(Subcommand.Set)
			.setDescription("Set a tomorrow's problems");
		for (let i = 1; i <= MAX_PROBLEMS; i++) {
			sub = sub.addStringOption((option) =>
				option
					.setName(`url${i}`)
					.setDescription("URL of Neetcode problem")
					.setRequired(i == 1),
			);
		}
		return sub.addIntegerOption((option) =>
			option
				.setName("days-from-today")
				.setDescription(
					"Date to set, as a number of days from today (0 = today, 1 = tomorrow, etc.)",
				),
		);
	});

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
		const url = interaction.options.getString(`url${i}`, i == 1);
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
			// Send a response with a confirm and a cancel button
			const buttonRow =
				new ActionRowBuilder<ButtonBuilder>().addComponents(
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
				content: `The following problems are already set for ${dateString}:
${formatProblemUrls(currentProblems)}
Are you sure you want to overwrite them?`,
				flags: MessageFlags.Ephemeral,
				components: [buttonRow],
				withResponse: true,
			});

			// Wait for the button to be clicked
			try {
				const click =
					await response.resource?.message?.awaitMessageComponent({
						time: 60_000, // 1 minute
					});
				if (click?.customId === "confirm") {
					// If confirmed, commit the changes and update the initial response
					await click.update({
						content: commitAndGetResponseContent(),
						components: [],
					});
				} else if (click?.customId === "cancel") {
					// If cancelled, update the initial response
					await click.update({
						content: "Cancelled.",
						components: [],
					});
				} else {
					console.error("Unexpected button click", click?.customId);
				}
			} catch (error) {
				if (
					error instanceof DiscordjsError &&
					error.code === DiscordjsErrorCodes.InteractionCollectorError
				) {
					// Timed out while waiting
					await interaction.editReply({
						content: "Timed out waiting for response.",
						components: [],
					});
				} else {
					throw error;
				}
			}
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

export { data, execute };
