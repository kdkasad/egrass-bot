import {
	ActivityType,
	Client,
	Events,
	GatewayIntentBits,
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
client.on(Events.InteractionCreate, (interaction) => {
	if (!interaction.isChatInputCommand()) return;

	const command = commands.get(interaction.commandName);
	command?.execute(interaction);
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
