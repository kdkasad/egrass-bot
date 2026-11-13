/*
 * Anonymous poll semantics/invariants:
 * - Poll question and choices are public information
 * - Nobody can know who voted
 * - Nobody can know who voted for which choices
 * - Results visibility is chosen by the author (participants or everyone)
 * - Results are not visible to anyone until the poll ends
 * - Polls have [2, 10] choices
 * - Poll duration is [1 minute, 1 week]
 */

import * as Sentry from "@sentry/bun";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	InteractionContextType,
	MessageFlags,
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type StringSelectMenuInteraction,
	type ModalSubmitInteraction,
} from "discord.js";

import { Feature } from "../../utils/service";
import { traced, wrapInteractionDo } from "../../utils/tracing";
import { ClockTimeSource, dateToSqlite, parseDuration, type TimeSource } from "../../utils/time";
import type { DatabaseService } from "../database";
import type { DiscordService } from "../discord";
import type { EnvService } from "../env";
import {
	CommandText,
	ComponentText,
	CreateErrors,
	ModalText,
	Replies,
	renderClosedAnnouncement,
	renderPublicClosedPoll,
	renderPollMessage,
	renderResults,
	renderPollList,
} from "./messages";
import { AnonPollStore, type PollInfo } from "./store";
import { PollCipher } from "./cipher";
import { anonPolls } from "../../db/schema";
import z from "zod";

enum ComponentPrefix {
	Create = "anonpoll/create",
	Vote = "anonpoll/vote",
	Results = "anonpoll/results",
}

const MAX_CHOICES = 10;
/** Discord's limit for select menu option labels */
const MAX_CHOICE_LENGTH = 100;
const MAX_QUESTION_LENGTH = 300;
const MIN_DURATION_MS = parseDuration("1m");
const MAX_DURATION_MS = parseDuration("1w");
const DEFAULT_DURATION = "1d";

export class AnonPollService extends Feature {
	static #commandSpec = new SlashCommandBuilder()
		.setName(CommandText.name)
		.setDescription(CommandText.description)
		.setContexts(InteractionContextType.Guild)
		.addSubcommand((subcommand) =>
			subcommand.setName("create").setDescription(CommandText.create),
		)
		.addSubcommand((subcommand) => subcommand.setName("list").setDescription(CommandText.list));

	#discord: DiscordService;
	#store: AnonPollStore;
	#time: TimeSource;

	constructor(
		env: EnvService,
		discord: DiscordService,
		db: DatabaseService,
		timeSource: TimeSource = new ClockTimeSource(),
	) {
		super(env);
		this.#discord = discord;
		this.#time = timeSource;
		const cipher = new PollCipher(env.vars.ANONPOLL_SECRET);
		this.#store = new AnonPollStore(db, cipher);
		if (this.isEnabled()) {
			this.#discord.registerSlashCommand(AnonPollService.#commandSpec, (i) =>
				this.#handleCommand(i),
			);
			this.#discord.registerModalHandler(ComponentPrefix.Create, (i) =>
				this.#handleSubmit(i),
			);
			this.#discord.registerSelectMenuHandler(ComponentPrefix.Vote, (i) =>
				this.#handleVote(i),
			);
			this.#discord.registerButtonHandler(ComponentPrefix.Results, (i) =>
				this.#handleResults(i),
			);
			for (const poll of this.#store.openPollDeadlines())
				this.#scheduleClose(poll.id, poll.closesAt);
			Sentry.logger.info(`${this._name} initialized`);
		} else {
			Sentry.logger.info(`${this._name} disabled`);
		}
	}

	#scheduleClose(pollId: string, closesAt: Date) {
		// Expired polls restored at startup close on the next event-loop turn.
		const delay = Math.min(
			Math.max(0, closesAt.getTime() - this.#time.now().getTime()),
			// Maximum delay supported by setTimeout()
			2 ** 31 - 1,
		);
		setTimeout(() => {
			// Recheck in case the timer was supposed to be longer but was capped by the setTimeout() limit
			if (this.#time.now() < closesAt) this.#scheduleClose(pollId, closesAt);
			else void this.#closePoll(pollId).catch((e) => Sentry.captureException(e));
		}, delay).unref();
	}

	/** True once voting has ended, even if the poll hasn't been formally closed yet */
	#isPastDeadline(poll: PollInfo): boolean {
		if (poll.closed) return true;
		if (poll.closesAt > this.#time.now()) return false;
		// The close timer hasn't fired yet; close it now so the announcement goes out.
		this.#closePoll(poll.id).catch((e) => Sentry.captureException(e));
		return true;
	}

	@traced("event.handler")
	async #handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		switch (interaction.options.getSubcommand()) {
			case "create":
				return this.#handleCreate(interaction);
			case "list":
				return this.#handleList(interaction);
			default:
				throw new Error("Unrecognized anonymous poll subcommand");
		}
	}

	async #handleList(interaction: ChatInputCommandInteraction): Promise<void> {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const polls = this.#store
			.listOpenPolls(interaction.guildId!, this.#time.now())
			.map((poll) => ({
				...poll,
				hasVoted: this.#store.hasVoted(poll.id, interaction.user.id),
			}));
		const pages = renderPollList(interaction.guildId!, polls);
		await interaction.editReply({ content: pages[0]!, allowedMentions: { parse: [] } });
		for (const content of pages.slice(1)) {
			await interaction.followUp({
				content,
				flags: MessageFlags.Ephemeral,
				allowedMentions: { parse: [] },
			});
		}
	}

	async #handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
		await interaction.showModal(
			new ModalBuilder()
				.setCustomId(ComponentPrefix.Create)
				.setTitle(ModalText.title)
				.addLabelComponents(
					new LabelBuilder()
						.setLabel(ModalText.question)
						.setTextInputComponent(
							new TextInputBuilder()
								.setCustomId("question")
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setMaxLength(MAX_QUESTION_LENGTH),
						),
					new LabelBuilder()
						.setLabel(ModalText.choices)
						.setDescription(ModalText.choicesDescription)
						.setTextInputComponent(
							new TextInputBuilder()
								.setCustomId("choices")
								.setStyle(TextInputStyle.Paragraph)
								.setRequired(true)
								.setMaxLength(
									// Discord's max is 4000
									Math.min((MAX_CHOICE_LENGTH + 1) * MAX_CHOICES, 4000),
								),
						),
					new LabelBuilder()
						.setLabel(ModalText.duration)
						.setDescription(ModalText.durationDescription)
						.setTextInputComponent(
							new TextInputBuilder()
								.setCustomId("duration")
								.setStyle(TextInputStyle.Short)
								.setRequired(false)
								.setValue(DEFAULT_DURATION)
								.setMaxLength(100),
						),
					new LabelBuilder()
						.setLabel(ModalText.visibility)
						.setStringSelectMenuComponent(
							new StringSelectMenuBuilder()
								.setCustomId("visibility")
								.setMinValues(1)
								.setMaxValues(1)
								.addOptions(
									{ label: ModalText.everyone, value: "everyone", default: true },
									{ label: ModalText.participants, value: "participants" },
								),
						),
				),
		);
	}

	@traced("event.handler")
	async #handleSubmit(interaction: ModalSubmitInteraction): Promise<void> {
		const question = interaction.fields.getTextInputValue("question").trim();
		const choices = Array.from(
			// Deduplicate choices
			new Set(
				interaction.fields
					.getTextInputValue("choices")
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			),
		);
		const durationMs = parseDuration(
			interaction.fields.getTextInputValue("duration").trim() || DEFAULT_DURATION,
		);

		let error: string | undefined;
		if (!question) error = CreateErrors.emptyQuestion;
		else if (question.length > MAX_QUESTION_LENGTH) error = CreateErrors.questionTooLong;
		else if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS)
			error = CreateErrors.badDuration;
		else if (choices.length < 2) error = CreateErrors.tooFewChoices;
		else if (choices.length > MAX_CHOICES) error = CreateErrors.tooManyChoices;
		else if (choices.some((choice) => choice.length > MAX_CHOICE_LENGTH))
			error = CreateErrors.choiceTooLong;
		if (error) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({ content: `${error} ${CreateErrors.tryAgain}`, flags: [MessageFlags.Ephemeral] });
			return;
		}

		// The interaction ID is a unique snowflake so we use it as the poll ID
		const poll: PollInfo = {
			id: interaction.id,
			authorId: interaction.user.id,
			question,
			choices,
			messageId: null,
			closesAt: new Date(this.#time.now().getTime() + durationMs),
			closed: false,
			resultsVisibility: z
				.enum(anonPolls.resultsVisibility.enumValues)
				.parse(interaction.fields.getStringSelectValues("visibility")[0]),
		};
		this.#store.createPoll({ ...poll, authorId: interaction.user.id });

		const select = new StringSelectMenuBuilder()
			.setCustomId(`${ComponentPrefix.Vote}:${poll.id}`)
			.setPlaceholder(ComponentText.votePlaceholder)
			.addOptions(choices.map((label, i) => ({ label, value: String(i) })));

		const response = await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: renderPollMessage(poll, 0),
			components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
			allowedMentions: { parse: [] },
			withResponse: true,
		});
		const message = response.resource?.message ?? null;
		if (!message) throw new Error("response.resource.message is null or undefined");
		this.#store.setMessage(poll.id, {
			message_id: message.id,
			guild_id: message.guildId!,
			channel_id: message.channelId,
			user_id: message.author.id,
			timestamp: dateToSqlite(message.createdAt),
			content: message.content,
		});
		this.#scheduleClose(poll.id, poll.closesAt);
		Sentry.logger.info("Anonymous poll created", {
			"poll.id": poll.id,
			"poll.choices": choices.length,
			"poll.closes_at": poll.closesAt,
		});
	}

	static resultsButtonRow(pollId: string) {
		return new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${ComponentPrefix.Results}:${pollId}`)
				.setLabel(ComponentText.viewResults)
				.setStyle(ButtonStyle.Secondary),
		);
	}

	// Never log or trace the selected value here: alongside the user ID it
	// would reveal how they voted.
	async #handleVote(interaction: StringSelectMenuInteraction): Promise<void> {
		const pollId = interaction.customId.split(":")[1]!;
		const choiceIdx = Number(interaction.values[0]);
		const result = this.#store.castVote(
			pollId,
			interaction.user.id,
			choiceIdx,
			this.#time.now(),
		);

		const poll = this.#store.getPoll(pollId);
		const messages: Record<typeof result, string> = {
			ok: poll ? Replies.voteRecorded(poll) : Replies.pollNotFound,
			already_voted: Replies.alreadyVoted,
			closed: Replies.pollClosed,
			no_poll: Replies.pollNotFound,
			bad_choice: Replies.badChoice,
		};
		await wrapInteractionDo(
			interaction,
			"reply",
		)({ content: messages[result], flags: [MessageFlags.Ephemeral] });

		if (!poll || result !== "ok") return;
		// Re-rendering the message also clears the voter's selection in the dropdown.
		try {
			await interaction.message.edit({
				content: renderPollMessage(poll, this.#store.voterCount(pollId)),
				allowedMentions: { parse: [] },
			});
		} catch (e) {
			Sentry.captureException(e);
		}
	}

	@traced("event.handler")
	async #handleResults(interaction: ButtonInteraction): Promise<void> {
		const pollId = interaction.customId.split(":")[1]!;
		const poll = this.#store.getPoll(pollId);
		let content: string;
		if (!poll) content = Replies.pollNotFound;
		else if (!this.#isPastDeadline(poll)) content = Replies.resultsNotReady(poll);
		else if (
			poll.resultsVisibility !== "everyone" &&
			!this.#store.isAuthor(pollId, interaction.user.id) &&
			!this.#store.hasVoted(pollId, interaction.user.id)
		)
			content = Replies.notVoted;
		else content = renderResults(this.#store.getResults(pollId)!);
		await wrapInteractionDo(
			interaction,
			"reply",
		)({ content, flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
	}

	@traced()
	async #closePoll(pollId: string) {
		const poll = this.#store.closePoll(pollId, this.#time.now());
		if (!poll) return;
		const voters = this.#store.voterCount(poll.id);
		Sentry.logger.info("Anonymous poll closed", {
			"poll.id": poll.id,
			"poll.voters": voters,
		});
		try {
			const channelId = this.#store.getChannelId(poll.id);
			if (!channelId) throw new Error("Poll message is not tracked");
			const channel = await this.#discord.client.channels.fetch(channelId);
			if (!channel?.isSendable()) throw new Error("Poll channel is not sendable");
			if (poll.messageId) {
				// Public polls show results inline; private polls use a results button.
				// The poll message may have been deleted, which shouldn't stop the
				// announcement.
				try {
					const message = await channel.messages.fetch(poll.messageId);
					await message.edit({
						content:
							poll.resultsVisibility === "everyone"
								? renderPublicClosedPoll(poll, this.#store.getResults(poll.id)!)
								: renderPollMessage(poll, voters),
						components:
							poll.resultsVisibility === "everyone"
								? []
								: [AnonPollService.resultsButtonRow(poll.id)],
						allowedMentions: { parse: [] },
					});
				} catch (e) {
					Sentry.captureException(e);
				}
			}
			await channel.send({
				content: renderClosedAnnouncement(poll),
				components:
					poll.resultsVisibility === "everyone"
						? []
						: [AnonPollService.resultsButtonRow(poll.id)],
				reply: poll.messageId
					? { messageReference: poll.messageId, failIfNotExists: false }
					: undefined,
				allowedMentions: { parse: [] },
			});
		} catch (e) {
			Sentry.captureException(e);
		}
	}
}
