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
import { getProblemsForTomorrow, setProblemsForTomorrow } from "../db";

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
			.setDescription("Set tomorrow's problems");
		for (let i = 1; i <= MAX_PROBLEMS; i++) {
			sub = sub.addStringOption((option) =>
				option
					.setName(`url${i}`)
					.setDescription("URL of Neetcode problem")
					.setRequired(i == 1),
			);
		}
		return sub;
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

	const commitAndGetResponseContent = () => {
		setProblemsForTomorrow(problems);
		return (
			"Problems set for given date:\n" +
			formatProblemUrls(getProblemsForTomorrow())
		);
	};

	try {
		// If problems are already set, confirm before overwriting
		const currentProblems = getProblemsForTomorrow();
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
				content: `The following problems are already set for the given date:
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
		console.error("Error setting problems", error);
	}
}

// Returns a string containing a Discord-style markdown list of the problems
function formatProblemUrls(problemUrls: string[]): string {
	let formattedUrls = "";
	for (let i = 0; i < problemUrls.length; i++) {
		if (i > 0) formattedUrls += "\n";
		formattedUrls += `- <${problemUrls[i]}>`;
	}
	return formattedUrls;
}

export { data, execute };
