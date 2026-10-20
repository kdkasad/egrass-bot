import * as Sentry from "@sentry/bun";
import {
	DiscordAPIError,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
} from "discord.js";
import { Feature } from "../utils/service";
import { traced, wrapInteractionDo } from "../utils/tracing";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";

export class IQService extends Feature {
	static readonly #mean = 60;
	static readonly #standardDeviation = 15;
	static readonly #timeoutThreshold = 63;

	static readonly #commandSpec = new SlashCommandBuilder()
		.setName("iq")
		.setDescription("Lot of IQs")
		.setContexts(InteractionContextType.Guild);

	#discord: DiscordService;

	constructor(env: EnvService, discord: DiscordService) {
		super(env);
		this.#discord = discord;
		if (this.isEnabled()) {
			this.#discord.registerSlashCommand(IQService.#commandSpec, (i) =>
				this.#handleCommand(i),
			);
			Sentry.logger.info(`${this._name} initialized`);
		} else {
			Sentry.logger.info(`${this._name} disabled`);
		}
	}

	@traced("event.handler")
	async #handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!interaction.inGuild()) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "This command can only be used in a server.",
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}
		if (interaction.guild === null) {
			Sentry.captureException(new Error(`Guild is null. guildId = ${interaction.guildId}`));
			return;
		}

		// Box-Muller transform for standard normal
		const R = Math.sqrt(-2 * Math.log(1 - Math.random()));
		const theta = 2 * Math.PI * Math.random();
		const standardNormal = R * Math.cos(theta);
		const smartness = Math.max(
			0,
			Math.round(IQService.#mean + IQService.#standardDeviation * standardNormal),
		);
		if (smartness > IQService.#timeoutThreshold) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)(`Your IQ is **${smartness}**! What a big brain!`);
			return;
		}

		// Acknowledge before making moderation requests, which may take a while.
		const defer = interaction.deferReply();
		let ending = "Please upgrade your brain.";
		const member = await interaction.guild.members.fetch(interaction.user.id);
		try {
			await member.timeout(60_000, "They're so smart... right?");
			ending = "Please shut the fuck up.";
		} catch (err) {
			let expectError = false;
			if (err instanceof DiscordAPIError && err.code == 50013) {
				// Permission error. If the member we tried to time out has a
				// higher role than our bot's highest role, this is expected,
				// and we should ignore the error.
				const botMember = await interaction.guild.members.fetchMe();
				if (
					interaction.guild.roles.comparePositions(
						member.roles.highest,
						botMember.roles.highest,
					) > 0
				) {
					expectError = true;
					Sentry.logger.warn(
						"Failed to apply IQ timeout; target member has higher role than bot",
						{
							"user.id": interaction.user.id,
							"guild.id": interaction.guildId,
							userRole: member.roles.highest.id,
							botRole: botMember.roles.highest.id,
						},
					);
				}
			}
			if (!expectError) {
				Sentry.logger.error("Failed to apply IQ timeout", {
					"user.id": interaction.user.id,
					"guild.id": interaction.guildId,
					error: err instanceof Error ? err.message : String(err),
				});
				Sentry.captureException(err);
			}
		}
		await defer;
		await wrapInteractionDo(
			interaction,
			"editReply",
		)(`Your IQ is **${smartness}**. You are dumber than a horse. ${ending}`);
	}
}
