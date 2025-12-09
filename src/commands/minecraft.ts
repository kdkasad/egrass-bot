import {
	AttachmentBuilder,
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import {
	clearMinecraftUsername,
	getMinecraftUsername,
	setMinecraftUsername,
} from "../db";
import { log } from "../logging";
import { env } from "../env";
import { Rcon } from "rcon-client";
import { Users } from "../consts";
import { yumImageBuf } from "../events/messages/atharva-dms";

enum Subcommands {
	Whitelist = "whitelist",
	Run = "run",
}

export const data = new SlashCommandBuilder()
	.setName("minecraft")
	.setDescription("Commands related to the Minecraft server")
	.addSubcommand((sub) =>
		sub
			.setName(Subcommands.Whitelist)
			.setDescription("Add yourself to the Minecraft server whitelist")
			.addStringOption((opt) =>
				opt
					.setName("username")
					.setDescription("Your Minecraft username")
					.setRequired(true),
			),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommands.Run)
			.setDescription("Run a command on the server")
			.addStringOption((option) =>
				option
					.setName("command")
					.setDescription("Command to run")
					.setRequired(true),
			)
			.addBooleanOption((option) =>
				option
					.setName("private")
					.setDescription(
						"If true, response will not be sent in channel",
					)
					.setRequired(false),
			),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	const subcommand = interaction.options.getSubcommand();
	try {
		switch (subcommand) {
			case Subcommands.Whitelist:
				await whitelist(interaction);
				break;
			case Subcommands.Run:
				await runCommand(interaction);
				break;
		}
	} catch (error) {
		if (error instanceof Error) {
			await interaction.reply({
				content: `⚠️ Error: ${error.message}`,
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}

async function whitelist(interaction: ChatInputCommandInteraction) {
	const username = interaction.options.getString("username", true);
	if (!username.match(/^\w+$/)) {
		log.warn("Suspicious Minecraft username detected", username);
		throw new Error(
			`Username "${username}" is suspicious; rejecting for security`,
		);
	}
	const oldUsername = getMinecraftUsername(interaction.user);
	if (oldUsername === username) {
		throw new Error("User is already whitelisted");
	} else if (oldUsername !== null) {
		await runMinecraftCommand(
			`whitelist remove ${oldUsername}`,
			/Removed \w+ from the whitelist/,
		);
	}
	try {
		await runMinecraftCommand(
			`whitelist add ${username}`,
			/Added \w+ to the whitelist/,
		);
		setMinecraftUsername(interaction.user, username);
	} catch (error) {
		clearMinecraftUsername(interaction.user);
		throw error;
	}
	await interaction.reply({
		content: `Added ${username} to the whitelist`,
		flags: MessageFlags.Ephemeral,
	});
}

async function runMinecraftCommand(
	command: string,
	expectedResponsePattern: RegExp,
) {
	if (
		env.MINECRAFT_RCON_HOST === undefined ||
		env.MINECRAFT_RCON_PORT === undefined
	)
		throw new Error("Minecraft server address is not configured");

	let client;
	try {
		client = await Rcon.connect({
			host: env.MINECRAFT_RCON_HOST,
			port: env.MINECRAFT_RCON_PORT,
			password: env.MINECRAFT_RCON_PASSWORD ?? "",
		});
	} catch (error) {
		log.error("RCON connection failed", error);
		throw new Error("Failed to connect to Minecraft server", {
			cause: error,
		});
	}
	let response: string;
	try {
		response = await client.send(command);
	} catch (error) {
		log.error("Sending RCON command failed", error);
		throw new Error("Running Minecraft command failed", {
			cause: error,
		});
	} finally {
		client.end();
	}
	if (!response.match(expectedResponsePattern)) {
		log.error("Unexpected response to RCON command", {
			command,
			response,
			expectedResponsePattern,
		});
		throw new Error(
			`Unexpected response from server; command probably failed: ${response}`,
		);
	}
	return response;
}

async function runCommand(interaction: ChatInputCommandInteraction) {
	// Permission check
	if (interaction.user.id !== Users.Kian) {
		await interaction.reply({
			files: [
				new AttachmentBuilder(Buffer.from(yumImageBuf), {
					name: "yum.gif",
				}),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const privateResponse = interaction.options.getBoolean("private") ?? false;
	const command = interaction.options.getString("command", true).trim();

	if (!command) {
		throw new Error("Empty command");
	}
	const response = await runMinecraftCommand(command, /.*?/);
	await interaction.reply({
		content: response,
		flags: privateResponse
			? [MessageFlags.SuppressEmbeds, MessageFlags.Ephemeral]
			: [MessageFlags.SuppressEmbeds],
		allowedMentions: { parse: [] },
	});
}
