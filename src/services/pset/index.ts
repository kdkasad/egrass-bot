import * as Sentry from "@sentry/bun";
import { Temporal } from "temporal-polyfill";
import z from "zod";
import {
	ActionRowBuilder,
	ApplicationIntegrationType,
	ButtonBuilder,
	ButtonInteraction,
	ButtonStyle,
	ChatInputCommandInteraction,
	InteractionContextType,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	ModalSubmitInteraction,
	roleMention,
	SlashCommandBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
	type InteractionReplyOptions,
} from "discord.js";

import { Feature } from "../../utils/service";
import type { DatabaseService } from "../database";
import type { DiscordService } from "../discord";
import type { EnvService } from "../env";
import { traced, wrapInteractionDo } from "../../utils/tracing";
import { Roles } from "../../consts";
import { fetchProblem, formatProblemTitle, ProblemURL, type LeetCodeProblem } from "./leetcode";
import { Result } from "../../utils/result";

type ButtonSpec = { prefix: string; emoji?: string; label: string; style: ButtonStyle };

interface ProblemSet {
	start: Temporal.ZonedDateTime;
	end: Temporal.ZonedDateTime;
	problems: LeetCodeProblem[];
}

enum Subcommand {
	Manage = "manage",
}

enum CustomID {
	Create = "pset/manage/create",
	ConfirmCreate = "pset/manage/create/confirm",
	CancelCreate = "pset/manage/create/cancel",
}

const Buttons = {
	Create: { prefix: CustomID.Create, emoji: "➕", label: "Create", style: ButtonStyle.Primary },
	ConfirmCreate: { prefix: CustomID.ConfirmCreate, label: "Confirm", style: ButtonStyle.Success },
	CancelCreate: { prefix: CustomID.CancelCreate, label: "Cancel", style: ButtonStyle.Danger },
} satisfies Record<string, ButtonSpec>;

const zPlainDate = (() => {
	const regex = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
	return z.codec(
		z.string().regex(regex, "Cannot parse YYYY-MM-DD date"),
		z.instanceof(Temporal.PlainDate),
		{
			decode: (s) => {
				const match = s.match(regex)!;
				const year = parseInt(match[1]);
				const month = parseInt(match[2]);
				const day = parseInt(match[3]);
				return new Temporal.PlainDate(year, month, day);
			},
			encode: (date) => date.toString(),
		},
	);
})();

export class PsetService extends Feature {
	// eslint-disable-next-line no-unused-private-class-members
	#db: DatabaseService;
	#discord: DiscordService;

	#pendingPsets: Map<string, ProblemSet> = new Map();

	static #command = new SlashCommandBuilder()
		.setName("pset")
		.setDescription("DSA problem sets")
		.setContexts(InteractionContextType.Guild)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.addSubcommand((subcommand) =>
			subcommand.setName(Subcommand.Manage).setDescription("Manage problem sets"),
		);

	constructor(env: EnvService, discord: DiscordService, db: DatabaseService) {
		super(env);
		this.#db = db;
		this.#discord = discord;

		if (this.isEnabled()) {
			this.#discord.registerSlashCommand(
				PsetService.#command,
				this.#handleSlashCommand.bind(this),
			);
			this.#registerHandlers();
			Sentry.logger.info(Sentry.logger.fmt`${this._name} initialized`);
		} else {
			Sentry.logger.info(Sentry.logger.fmt`${this._name} disabled`);
		}
	}

	#registerHandlers() {
		const buttonDispatcher: Record<
			keyof typeof Buttons,
			(interaction: ButtonInteraction) => Promise<void>
		> = {
			Create: this.#handleCreatePsetButtonPress,
			ConfirmCreate: this.#handleConfirmCreatePsetButtonPress,
			CancelCreate: this.#handleCancelCreatePsetButtonPress,
		};
		for (const [name, spec] of Object.entries(Buttons)) {
			this.#discord.registerButtonHandler(
				spec.prefix,
				buttonDispatcher[name as keyof typeof Buttons].bind(this),
			);
		}

		this.#discord.registerModalHandler(
			CustomID.Create,
			this.#handleCreateModalSubmit.bind(this),
		);
	}

	@traced("event.handler")
	async #handleSlashCommand(interaction: ChatInputCommandInteraction) {
		// We set the command to only show up in guild contexts
		if (!interaction.guildId) throw new Error("interaction not in guild");
		const subcommand = z.enum(Subcommand).parse(interaction.options.getSubcommand(true));
		const dispatcher: Record<
			Subcommand,
			(interaction: ChatInputCommandInteraction) => Promise<void>
		> = {
			[Subcommand.Manage]: this.#subcommandManage,
		};
		try {
			dispatcher[subcommand].call(this, interaction);
		} catch (error) {
			Sentry.captureException(error);
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `⚠️ Error: ${error instanceof Error ? error.message : error}`,
				flags: [MessageFlags.Ephemeral],
			});
		}
	}

	#createButton(button: ButtonSpec, customData?: string): ButtonBuilder {
		let builder = new ButtonBuilder()
			.setCustomId(customData ? `${button.prefix}:${customData}` : button.prefix)
			.setLabel(button.label)
			.setStyle(button.style);
		if (button.emoji !== undefined) {
			builder = builder.setEmoji(button.emoji);
		}
		return builder;
	}

	@traced("event.handler")
	async #subcommandManage(interaction: ChatInputCommandInteraction) {
		this.#requireUserIsProblemSetter(interaction, async () => {
			const buttonRow = new ActionRowBuilder<ButtonBuilder>().setComponents(
				this.#createButton(Buttons.Create),
			);
			await this.#discord.interactionReply(interaction, {
				flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral],
				components: [buttonRow],
			} satisfies InteractionReplyOptions);
		});
	}

	async #requireUserIsProblemSetter(
		interaction: ChatInputCommandInteraction,
		f: () => Promise<void>,
	): Promise<void> {
		let hasRole: boolean;
		if (Array.isArray(interaction.member!.roles)) {
			hasRole =
				interaction.member!.roles.find((role) => role === Roles.ProblemSetter) !==
				undefined;
		} else {
			hasRole = interaction.member!.roles.cache.has(Roles.ProblemSetter);
		}
		if (hasRole) {
			await f();
		} else {
			await interaction.reply({
				content: `🚫 You are not a ${roleMention(Roles.ProblemSetter)}`,
				flags: [MessageFlags.Ephemeral],
			});
		}
	}

	@traced("event.handler")
	async #handleCreatePsetButtonPress(interaction: ButtonInteraction) {
		const modal = new ModalBuilder()
			.setCustomId(CustomID.Create)
			.setTitle("Create a problem set")
			.setLabelComponents(
				new LabelBuilder()
					.setLabel("Start date (ET)")
					.setDescription("The first date for which the problem set will be open")
					.setTextInputComponent(
						new TextInputBuilder()
							.setCustomId("startDate")
							.setPlaceholder("2026-06-07")
							.setRequired(true)
							.setStyle(TextInputStyle.Short),
					),
				new LabelBuilder()
					.setLabel("End date (ET)")
					.setDescription(
						"The last date during which the problem set will be open (defaults to the start date)",
					)
					.setTextInputComponent(
						new TextInputBuilder()
							.setCustomId("endDate")
							.setPlaceholder("2026-06-07")
							.setRequired(false)
							.setStyle(TextInputStyle.Short),
					),
				new LabelBuilder()
					.setLabel("Problem URLs")
					.setDescription("One URL per line")
					.setTextInputComponent(
						new TextInputBuilder()
							.setCustomId("urls")
							.setPlaceholder("https://leetcode.com/problems/two-sum/")
							.setRequired(true)
							.setStyle(TextInputStyle.Paragraph),
					),
			);
		await interaction.showModal(modal);
	}

	@traced("event.handler")
	async #handleCreateModalSubmit(interaction: ModalSubmitInteraction) {
		const formInput = {
			startDate: interaction.fields.getTextInputValue("startDate"),
			endDate: interaction.fields.getTextInputValue("endDate"),
			problems: interaction.fields.getTextInputValue("urls"),
		};

		const data = z
			.object({
				startDate: zPlainDate,
				endDate: zPlainDate,
				problems: z
					.string()
					.transform((s) => s.split(/\s+/).filter((s) => s !== ""))
					.pipe(z.array(ProblemURL)),
			})
			.safeDecode(formInput);
		if (!data.success) {
			await this.#discord.interactionReply(interaction, {
				content: `**⚠️ Invalid input**:\n${z.prettifyError(data.error)}`,
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}

		try {
			console.log("before deferReply");
			await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
			console.log("after deferReply");
			const problemsResult = Result.collect(
				await Promise.all(data.data.problems.map((id) => fetchProblem(id))),
			);
			await Result.match(problemsResult, {
				error: async (errors) => {
					await wrapInteractionDo(
						interaction,
						"editReply",
					)({
						content: "⚠️ **Error(s):**\n" + errors.map((e) => `- ${e.message}`),
					});
				},
				ok: async (problems) => {
					const start = data.data.startDate.toZonedDateTime(
						"America/Indiana/Indianapolis",
					);
					const end = data.data.endDate.toZonedDateTime("America/Indiana/Indianapolis");
					const pset: ProblemSet = { start, end, problems };
					await this.#sendCreatePsetConfirmation(interaction, pset);
				},
			});
		} catch (error) {
			await this.#discord.interactionReply(interaction, {
				content: `⚠️ Error: ${error instanceof Error ? error.message : error}`,
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}
	}

	async #sendCreatePsetConfirmation(interaction: ModalSubmitInteraction, pset: ProblemSet) {
		const id = crypto.randomUUID();
		const formatDate = (date: Temporal.ZonedDateTime) => {
			const epochSeconds = Math.floor(date.toInstant().epochMilliseconds / 1000);
			const etDate = date.toPlainDate().toLocaleString("en-US", { dateStyle: "medium" });
			return `<t:${epochSeconds}:F> (${etDate} ET)`;
		};
		const text = new TextDisplayBuilder().setContent(`## Create problem set?
**Problems:**
${pset.problems.map((p) => "- " + formatProblemTitle(p)).join("\n")}
**Start date:** ${formatDate(pset.start)}
**End date:** ${formatDate(pset.end)}
`);
		const buttons = new ActionRowBuilder<ButtonBuilder>().setComponents(
			this.#createButton(Buttons.ConfirmCreate, id),
			this.#createButton(Buttons.CancelCreate, id),
		);
		await wrapInteractionDo(
			interaction,
			"editReply",
		)({
			flags: [MessageFlags.IsComponentsV2],
			components: [text, buttons],
		});
		this.#pendingPsets.set(id, pset);
	}

	async #handleConfirmCreatePsetButtonPress(interaction: ButtonInteraction) {
		try {
			const pendingPsetId = interaction.customId.split(":")[1]!;
			const pendingPset = this.#pendingPsets.get(pendingPsetId);
			if (!pendingPset) {
				await this.#discord.interactionReply(interaction, {
					content:
						"⚠️ Error: Unknown problem set.\nMost likely this problem set has already been confirmed or canceled.",
					flags: [MessageFlags.Ephemeral],
				});
				return;
			}
			// FIXME: wrap this with a Sentry span in DiscordService
			await interaction.update({
				components: [
					new TextDisplayBuilder().setContent(
						"✅ Problem set created.\n-# Just kidding! This is just a preview of the UI.",
					),
				],
			});
			this.#pendingPsets.delete(pendingPsetId);
		} catch (error) {
			await this.#discord.interactionReply(interaction, {
				content: `⚠️ Error: ${error instanceof Error ? error.message : error}`,
				flags: [MessageFlags.Ephemeral],
			});
		}
	}

	async #handleCancelCreatePsetButtonPress(interaction: ButtonInteraction) {
		try {
			const pendingPsetId = interaction.customId.split(":")[1]!;
			await interaction.update({
				components: [
					new TextDisplayBuilder().setContent("❌ Problem set creation canceled."),
				],
			});
			this.#pendingPsets.delete(pendingPsetId);
		} catch (error) {
			await this.#discord.interactionReply(interaction, {
				content: `⚠️ Error: ${error instanceof Error ? error.message : error}`,
				flags: [MessageFlags.Ephemeral],
			});
		}
	}
}
