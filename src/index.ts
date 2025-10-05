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
import { db } from "./db";
import { jobs } from "./jobs";
import * as events from "./events";

// Update application commands
const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);
try {
	rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), {
		body: commands.map((command) => command.data.toJSON()),
	});
	console.log("Application commands updated");
} catch (error) {
	console.error("Failed to update application commands", error);
	process.exit(1);
}

// Create a new client instance
const client = new Client({
	intents: [GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.Guilds],
	partials: [Partials.Reaction, Partials.Message],
});

// When the client is ready, run this code (only once).
client.once(Events.ClientReady, (readyClient) => {
	console.log(`Logged in as ${readyClient.user.tag}`);

	readyClient.user.setActivity({
		name: "you",
		type: ActivityType.Watching,
	});

	for (const job of jobs) {
		const task = job.createJob(readyClient);
		const nextRun = task.getNextRun();
		if (task.name && nextRun) {
			console.debug(
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
	console.warn(`Received ${signal}; exiting...`);
	process.exit();
};
process.on("SIGINT", signalHandler);
process.on("SIGTERM", signalHandler);
process.on("exit", () => {
	client.destroy();
	console.debug("Client destroyed");
	db.close(false);
	console.debug("Database connection closed");
});

// Log in to Discord
client.login(env.DISCORD_BOT_TOKEN);
