/*
 * Anonymous poll semantics/invariants:
 * - Poll question and choices are public information
 * - Nobody can know who voted
 * - Nobody can know who voted for which choices
 * - Only those who voted can see the results
 * - Results are not visible to anyone until the poll ends
 * - Polls have [1, 10] choices
 * - Poll duration is [1 minute, 1 week]
 */

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
import type { DatabaseService } from "../database";
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
import { PollCipher } from "./cipher";

enum ComponentPrefix {
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
			);
		for (let i = 1; i <= MAX_CHOICES; i++) {
			builder.addStringOption((o) =>
				o
					.setName(`choice${i}`)
					.setDescription(CommandText.choice(i))
					.setRequired(i == 1)
					.setMaxLength(MAX_CHOICE_LENGTH),
			);
		}
		builder.addStringOption((o) =>
			o.setName("duration").setDescription(CommandText.duration).setRequired(false),
		);
		return builder;
	})();

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
		this.#store = new AnonPollStore(db, new PollCipher(env.vars.ANONPOLL_SECRET));
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
			for (const poll of this.#store.openPollDeadlines())
				this.#scheduleClose(poll.id, poll.closesAt);
			Sentry.logger.info(`${this._name} initialized`);
		} else {
			Sentry.logger.info(`${this._name} disabled`);
		}
	}

	#scheduleClose(pollId: string, closesAt: Date) {
		// Expired polls restored at startup close on the next event-loop turn.
		const delay = Math.max(0, closesAt.getTime() - this.#time.now().getTime());
		setTimeout(
			() => {
				// Recheck in case the clock moved backwards. Capping also supports
				// existing polls created under the previous 30-day duration limit.
				if (this.#time.now() < closesAt) this.#scheduleClose(pollId, closesAt);
				else void this.#closePoll(pollId).catch((e) => Sentry.captureException(e));
			},
			Math.min(delay, 2 ** 31 - 1),
		).unref();
	}

	/** True once voting has ended, even if the poll hasn't been formally closed yet */
	#isPastDeadline(poll: PollInfo): boolean {
		if (poll.closed) return true;
		if (poll.closesAt > this.#time.now()) return false;
		// The close timer hasn't fired yet; close it now so the announcement goes out.
		void this.#closePoll(poll.id).catch((e) => Sentry.captureException(e));
		return true;
	}

	@traced("event.handler")
	async #handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		const question = interaction.options.getString("question", true).trim();
		const durationMs = parseDuration(
			interaction.options.getString("duration") ?? DEFAULT_DURATION,
		);
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
			messageId: null,
			closesAt: new Date(this.#time.now().getTime() + durationMs),
			closed: false,
		};
		this.#store.createPoll(poll);

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
