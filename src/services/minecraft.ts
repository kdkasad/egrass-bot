import * as Sentry from "@sentry/bun";

import { Feature } from "../utils/service";
import type { EnvService } from "./env";
import type { DiscordService } from "./discord";
import { traced, wrapInteractionDo } from "../utils/tracing";
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import z from "zod";
import type { DatabaseService } from "./database";
import { minecraft } from "../db/schema";
import { Users } from "../consts";
import { Rcon, type RconOptions } from "rcon-client";
import { eq } from "drizzle-orm";

enum Subcommand {
	Whitelist = "whitelist",
	Run = "run",
}

export class MinecraftService extends Feature {
	static #commandSpec = new SlashCommandBuilder()
		.setName("minecraft")
		.setDescription("Minecraft-related commands")
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.Whitelist)
				.setDescription("Whitelist your user on the Minecraft server")
				.addStringOption((opt) =>
					opt
						.setName("username")
						.setRequired(true)
						.setDescription("Minecraft username to whitelist"),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.Run)
				.setDescription("Run a command in the Minecraft server")
				.addStringOption((opt) =>
					opt.setName("command").setRequired(true).setDescription("Command to run"),
				)
				.addBooleanOption((opt) =>
					opt
						.setName("public")
						.setRequired(false)
						.setDescription("Whether to show the output of the command"),
				),
		);

	#discord: DiscordService;
	#db: DatabaseService;
	#rconOptions!: RconOptions;
	#subcommandDispatcher!: Record<
		Subcommand,
		(interaction: ChatInputCommandInteraction) => Promise<void>
	>;

	constructor(env: EnvService, discord: DiscordService, db: DatabaseService) {
		super(env);
		this.#discord = discord;
		this.#db = db;

		if (this.isEnabled()) {
			this.#discord.registerSlashCommand(MinecraftService.#commandSpec, (i) =>
				this.#handleCommand(i),
			);
			this.#subcommandDispatcher = {
				[Subcommand.Whitelist]: this.#handleWhitelist,
				[Subcommand.Run]: this.#handleRun,
			};
			this.#rconOptions = {
				host: env.vars.MINECRAFT_RCON_HOST,
				port: env.vars.MINECRAFT_RCON_PORT,
				password: env.vars.MINECRAFT_RCON_PASSWORD,
			};
			Sentry.logger.info(Sentry.logger.fmt`${this._name} initialized`);
		} else {
			Sentry.logger.info(Sentry.logger.fmt`${this._name} disabled`);
		}
	}

	@traced("event.handler")
	async #handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		// Get subcommand
		const parseResult = z.enum(Subcommand).safeParse(interaction.options.getSubcommand());
		if (!parseResult.success) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "⚠️ Error: unrecognized subcommand",
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}
		const subcommand = parseResult.data;
		Sentry.getActiveSpan()?.setAttributes({
			"discord.command.subcommand": subcommand,
		});

		// Dispatch to subcommand handler
		const handler = this.#subcommandDispatcher[subcommand];
		try {
			await handler.call(this, interaction);
		} catch (err) {
			Sentry.captureException(err);
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `⚠️ Error: ${err instanceof Error ? err.message : err}`,
				flags: [MessageFlags.Ephemeral],
			});
		}
	}

	@traced("event.handler")
	async #handleWhitelist(interaction: ChatInputCommandInteraction): Promise<void> {
		const reply = await wrapInteractionDo(interaction, "reply");

		const username = interaction.options.getString("username", true);

		// Validate username
		if (!/^\w+$/.test(username)) {
			Sentry.logger.info(
				Sentry.logger.fmt`Denying whitelist request: suspicious username: ${username}`,
			);
			await reply({
				content: "🚫 Request denied: suspicious username",
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}

		// Handle old MC username if exists
		const qryResult = await this.#db.query("select Minecraft username", (tx) =>
			tx.query.minecraft.findFirst({
				columns: { mc_username: true },
				where: eq(minecraft.discord_id, interaction.user.id),
			}),
		);
		const oldUsername = qryResult?.mc_username;
		if (oldUsername === username) {
			Sentry.logger.info("Old username = new username; doing nothing", {
				"minecraft.username": username,
			});
			await reply({
				content: `You're already whitelisted as ${oldUsername}`,
				flags: [MessageFlags.Ephemeral],
			});
			return;
		} else if (oldUsername !== undefined) {
			await this.#runMinecraftCommand(
				`whitelist remove ${oldUsername}`,
				/Removed \w+ from the whitelist/,
			);
			Sentry.logger.info("Old username removed from whitelist", {
				"minecraft.username": oldUsername,
			});
		}

		// Whitelist user
		try {
			await this.#runMinecraftCommand(
				`whitelist add ${username}`,
				/Added \w+ to the whitelist/,
			);
			Sentry.logger.info("User added to whitelist", {
				"minecraft.username": username,
			});
			await this.#db.query("upsert Minecraft username", (tx) =>
				tx
					.insert(minecraft)
					.values({
						discord_id: interaction.user.id,
						mc_username: username,
					})
					.onConflictDoUpdate({
						target: minecraft.discord_id,
						set: {
							mc_username: username,
						},
					}),
			);
			Sentry.logger.info("Minecraft username saved in database", {
				"minecraft.username": username,
			});
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `✅ Whitelisted \`${username}\``,
				flags: [MessageFlags.Ephemeral],
			});
		} catch (err) {
			// On failure, remove the user from the database
			await this.#db.query("remove Minecraft username", (tx) =>
				tx.delete(minecraft).where(eq(minecraft.discord_id, interaction.user.id)),
			);
			throw err;
		}
	}

	@traced("event.handler")
	async #handleRun(interaction: ChatInputCommandInteraction): Promise<void> {
		// Check permission
		if (interaction.user.id !== Users.Kian) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "🚫 Permission denied",
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}

		const command = interaction.options.getString("command", true);
		const output = await this.#runMinecraftCommand(command, /.*?/);
		const publik = interaction.options.getBoolean("public") ?? false;
		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: output,
			flags: publik
				? [MessageFlags.SuppressEmbeds]
				: [MessageFlags.SuppressEmbeds, MessageFlags.Ephemeral],
			allowedMentions: { parse: [] },
		});
	}

	@traced("minecraft.command")
	async #runMinecraftCommand(command: string, expectedResponsePattern: RegExp): Promise<string> {
		Sentry.logger.debug(`Running Minecraft command: ${command}`);
		const rcon = await Rcon.connect(this.#rconOptions).catch((err) => {
			Sentry.logger.error(
				Sentry.logger.fmt`Failed to connect to Minecraft server: ${(err as Error).message}`,
			);
			throw new Error("Failed to connect to Minecraft server", { cause: err });
		});
		const output = await rcon
			.send(command)
			.catch((err) => {
				Sentry.logger.error(
					Sentry.logger.fmt`Sending Minecraft command failed: ${(err as Error).message}`,
				);
				throw new Error("Failed to send command to Minecraft server", { cause: err });
			})
			.finally(() => rcon.end());
		if (expectedResponsePattern.test(output)) {
			return output;
		} else {
			const msg = Sentry.logger
				.fmt`Unexpected response from Minecraft server (command probably failed): ${output}`;
			Sentry.logger.error(msg);
			throw new Error(msg.toString());
		}
	}
}
