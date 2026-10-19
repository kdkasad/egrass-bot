import * as Sentry from "@sentry/bun";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";

import { Feature } from "../../utils/service";
import { traced, wrapInteractionDo } from "../../utils/tracing";
import { ClockTimeSource, dateToSqlite, parseDuration, type TimeSource } from "../../utils/time";
import type { CronService } from "../cron";
import type { DiscordService } from "../discord";
import type { EnvService } from "../env";
import {
	CommandText,
	ComponentText,
	CreateErrors,
	Replies,
	renderClosedAnnouncement,
	renderPollMessage,
	renderResults,
} from "./messages";
import { AnonPollStore, type PollInfo } from "./store";

enum ComponentPrefix {
	Vote = "anonpoll/vote",
	Results = "anonpoll/results",
}

const MAX_CHOICES = 10;
/** Discord's limit for select menu option labels */
const MAX_CHOICE_LENGTH = 100;
const MAX_QUESTION_LENGTH = 300;
const MIN_DURATION_MS = parseDuration("1m");
const MAX_DURATION_MS = parseDuration("30d");
/** setTimeout can't wait longer than this; the cron job closes polls past it */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * Deadlines are stored in whole seconds, so a timer that fires a few
 * milliseconds early would find nothing to close.
 */
const TIMER_MARGIN_MS = 1000;

export class AnonPollService extends Feature {
	static #commandSpec = (() => {
		const builder = new SlashCommandBuilder()
			.setName(CommandText.name)
			.setDescription(CommandText.description)
			.setContexts(InteractionContextType.Guild)
			.addStringOption((o) =>
				o
					.setName("question")
					.setDescription(CommandText.question)
					.setRequired(true)
					.setMaxLength(MAX_QUESTION_LENGTH),
			)
			.addStringOption((o) =>
				o.setName("duration").setDescription(CommandText.duration).setRequired(true),
			);
		for (let i = 1; i <= MAX_CHOICES; i++) {
			builder.addStringOption((o) =>
				o
					.setName(`choice${i}`)
					.setDescription(CommandText.choice(i))
					.setRequired(i <= 2)
					.setMaxLength(MAX_CHOICE_LENGTH),
			);
		}
		return builder;
	})();

	#discord: DiscordService;
	#store: AnonPollStore;
	#time: TimeSource;

	constructor(
		env: EnvService,
		discord: DiscordService,
		cron: CronService,
		timeSource: TimeSource = new ClockTimeSource(),
	) {
		super(env);
		this.#discord = discord;
		this.#time = timeSource;
		this.#store = new AnonPollStore(env.vars.ANONPOLL_DATABASE_FILE);
		if (this.isEnabled()) {
			this.#discord.registerSlashCommand(AnonPollService.#commandSpec, (i) =>
				this.#handleCommand(i),
			);
			this.#discord.registerSelectMenuHandler(ComponentPrefix.Vote, (i) =>
				this.#handleVote(i),
			);
			this.#discord.registerButtonHandler(ComponentPrefix.Results, (i) =>
				this.#handleResults(i),
			);
			// Each poll gets a timer for its deadline. The cron job is a backstop for
			// polls whose deadline is too far away for a timer.
			cron.createJob("close anonymous polls", "* * * * *", () => this.#closeDuePolls());
			for (const closesAt of this.#store.openPollDeadlines()) this.#scheduleClose(closesAt);
			Sentry.logger.info(`${this._name} initialized`);
		} else {
			Sentry.logger.info(`${this._name} disabled`);
		}
	}

	#now(): number {
		return dateToSqlite(this.#time.now());
	}

	/** @param closesAt seconds since epoch */
	#scheduleClose(closesAt: number) {
		const delay = Math.max(0, closesAt * 1000 - this.#time.now().getTime() + TIMER_MARGIN_MS);
		if (delay > MAX_TIMER_MS) return;
		setTimeout(() => void this.#closeDuePolls(), delay).unref();
	}

	/** True once voting has ended, even if the poll hasn't been formally closed yet */
	#isPastDeadline(poll: PollInfo): boolean {
		if (poll.closed) return true;
		if (poll.closesAt > this.#now()) return false;
		// The close timer hasn't fired yet; close it now so the announcement goes out.
		void this.#closeDuePolls();
		return true;
	}

	@traced("event.handler")
	async #handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		const question = interaction.options.getString("question", true).trim();
		const durationMs = parseDuration(interaction.options.getString("duration", true));
		const choices: string[] = [];
		for (let i = 1; i <= MAX_CHOICES; i++) {
			const choice = interaction.options.getString(`choice${i}`)?.trim();
			if (choice) choices.push(choice);
		}

		let error: string | undefined;
		if (!question) error = CreateErrors.emptyQuestion;
		else if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS)
			error = CreateErrors.badDuration;
		else if (choices.length < 2) error = CreateErrors.tooFewChoices;
		else if (new Set(choices).size !== choices.length) error = CreateErrors.duplicateChoices;
		if (error) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({ content: error, flags: [MessageFlags.Ephemeral] });
			return;
		}

		// The interaction ID is a unique snowflake, so it doubles as the poll ID.
		const poll: PollInfo = {
			id: interaction.id,
			question,
			choices,
			channelId: interaction.channelId,
			messageId: null,
			closesAt: this.#now() + Math.round(durationMs / 1000),
			closed: false,
		};
		this.#store.createPoll(poll);

		const select = new StringSelectMenuBuilder()
			.setCustomId(`${ComponentPrefix.Vote}:${poll.id}`)
			.setPlaceholder(ComponentText.votePlaceholder)
			.addOptions(choices.map((label, i) => ({ label, value: String(i) })));

		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: renderPollMessage(poll, 0),
			components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
			allowedMentions: { parse: [] },
		});
		const message = await interaction.fetchReply();
		this.#store.setMessageId(poll.id, message.id);
		this.#scheduleClose(poll.closesAt);
		Sentry.logger.info("Anonymous poll created", {
			"poll.id": poll.id,
			"poll.choices": choices.length,
			"poll.closes_at": poll.closesAt,
		});
	}

	static #resultsRow(pollId: string) {
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
		const result = this.#store.castVote(pollId, interaction.user.id, choiceIdx, this.#now());

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

		// Re-rendering the message also clears the voter's selection in the dropdown.
		if (poll && !this.#isPastDeadline(poll)) {
			try {
				await interaction.message.edit({
					content: renderPollMessage(poll, this.#store.voterCount(pollId)),
					allowedMentions: { parse: [] },
				});
			} catch (e) {
				Sentry.captureException(e);
			}
		}
	}

	@traced("event.handler")
	async #handleResults(interaction: ButtonInteraction): Promise<void> {
		const pollId = interaction.customId.split(":")[1]!;
		const poll = this.#store.getPoll(pollId);
		let content: string;
		if (!poll) content = Replies.pollNotFound;
		else if (!this.#isPastDeadline(poll)) content = Replies.resultsNotReady(poll);
		else if (!this.#store.hasVoted(pollId, interaction.user.id)) content = Replies.notVoted;
		else content = renderResults(this.#store.getResults(pollId)!);
		await wrapInteractionDo(
			interaction,
			"reply",
		)({ content, flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
	}

	@traced()
	async #closeDuePolls() {
		const closed = this.#store.closeDuePolls(this.#now());
		for (const poll of closed) {
			const voters = this.#store.voterCount(poll.id);
			Sentry.logger.info("Anonymous poll closed", {
				"poll.id": poll.id,
				"poll.voters": voters,
			});
			try {
				const channel = await this.#discord.client.channels.fetch(poll.channelId);
				if (!channel?.isSendable()) throw new Error("Poll channel is not sendable");
				if (poll.messageId) {
					// Remove the vote dropdown; results are reached from the announcement.
					// The poll message may have been deleted, which shouldn't stop the
					// announcement.
					try {
						const message = await channel.messages.fetch(poll.messageId);
						await message.edit({
							content: renderPollMessage(poll, voters),
							components: [],
							allowedMentions: { parse: [] },
						});
					} catch (e) {
						Sentry.captureException(e);
					}
				}
				await channel.send({
					content: renderClosedAnnouncement(poll, voters),
					components: [AnonPollService.#resultsRow(poll.id)],
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
}
