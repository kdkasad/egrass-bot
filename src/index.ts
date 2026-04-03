import * as Sentry from "@sentry/bun";
import {
	ActivityType,
	Client,
	Events,
	GatewayIntentBits,
	MessageFlags,
	Partials,
	REST,
	Routes,
} from "discord.js";
import { commands } from "./commands";
import { env } from "./env";
import { jobs } from "./jobs";
import * as events from "./events";
import { closeDatabase } from "./db";
import { log } from "./logging";
import { wrapError } from "./utils";

Sentry.init({
	dsn: env.SENTRY_DSN,
	enableLogs: true,
});

// Update application commands
const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);
wrapError("failed to update application commands", () => {
	rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), {
		body: commands.map((command) => command.data.toJSON()),
	});
	log.info("Application commands updated");
});

// Create a new client instance
const client = new Client({
	intents: [
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
	],
	partials: [Partials.Reaction, Partials.Message, Partials.Channel],
});

// When the client is ready, run this code (only once).
client.once(Events.ClientReady, (readyClient) => {
	log.info(`Logged in`, { tag: readyClient.user.tag });

	readyClient.user.setActivity({
		name: "you",
		type: ActivityType.Watching,
	});

	for (const job of jobs) {
		const task = job.createJob(readyClient);
		if (!task) continue;
		const nextRun = task.getNextRun();
		if (task.name && nextRun) {
			log.info(
				`Job ${task.name} will first run at ${nextRun.toUTCString()}`,
			);
		}
	}

	events.register(readyClient);
});

// Command interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;

	const command = commands.get(interaction.commandName);
	if (!command) return;

	await Sentry.withIsolationScope(async () => {
		Sentry.setTag("handler", `command:${interaction.commandName}`);
		Sentry.setUser({ id: interaction.user.id, username: interaction.user.username });
		Sentry.setContext("discord.interaction", {
			id: interaction.id,
			guildId: interaction.guildId,
			channelId: interaction.channelId,
			commandName: interaction.commandName,
			options: interaction.options.data,
		});
		try {
			await command.execute(interaction);
		} catch (error) {
			Sentry.captureException(error);
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: "An error occurred.", flags: MessageFlags.Ephemeral }).catch(() => {});
			} else {
				await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral }).catch(() => {});
			}
		}
	});
});

// For some reason, the program doesn't seem to stop when it gets a signal
// unless we handle it explicitly.
const signalHandler: NodeJS.SignalsListener = (signal) => {
	log.warn("Received signal; exiting...", { signal });
	process.exit();
};
process.on("SIGINT", signalHandler);
process.on("SIGTERM", signalHandler);
process.on("exit", () => {
	client.destroy();
	log.info("Client destroyed");
	closeDatabase(false);
	log.info("Database connection closed");
});

// Log in to Discord
client.login(env.DISCORD_BOT_TOKEN);
