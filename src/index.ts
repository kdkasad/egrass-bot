import {
	ActivityType,
	Client,
	Events,
	GatewayIntentBits,
	REST,
	Routes,
} from "discord.js";
import { commands } from "./commands";
import { env } from "./env";
import { db } from "./db";

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
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// When the client is ready, run this code (only once).
client.once(Events.ClientReady, (readyClient) => {
	console.log(`Logged in as ${readyClient.user.tag}`);

	readyClient.user.setActivity({
		name: "you",
		type: ActivityType.Watching,
	});
});

// Command interaction handler
client.on(Events.InteractionCreate, (interaction) => {
	if (!interaction.isChatInputCommand()) return;

	const command = commands.get(interaction.commandName);
	command?.execute(interaction);
});

// Graceful exit handlers
process.on("SIGINT", (signal) => {
	console.warn("Received SIGINT; exiting...");
	process.exit();
});
process.on("exit", () => {
	client.destroy();
	console.debug("Client destroyed");
	db.close(false);
	console.debug("Database connection closed");
});

// Log in to Discord
client.login(env.DISCORD_BOT_TOKEN);
