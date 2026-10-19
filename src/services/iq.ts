import * as Sentry from "@sentry/bun";
import {
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
	static #commandSpec = new SlashCommandBuilder()
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

		const smartness = Math.floor(Math.random() * 121);
		if (smartness > 70) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)(`Your IQ is **${smartness}**! What a big brain!`);
			return;
		}

		// Acknowledge before making moderation requests, which may take a while.
		const defer = interaction.deferReply();
		let ending = "Please upgrade your brain.";
		try {
			const member = await interaction.guild.members.fetch(interaction.user.id);
			await member.timeout(60_000, "They're so smart... right?");
			ending = "Please shut the fuck up.";
		} catch (err) {
			Sentry.logger.error("Failed to apply IQ timeout", {
				"user.id": interaction.user.id,
				"guild.id": interaction.guildId,
				error: err instanceof Error ? err.message : String(err),
			});
			Sentry.captureException(err);
		}
		await defer;
		await wrapInteractionDo(
			interaction,
			"editReply",
		)(`Your IQ is **${smartness}**. You are dumber than a horse. ${ending}`);
	}
}
