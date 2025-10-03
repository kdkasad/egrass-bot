import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';

// Read bot token from environment
const token = process.env.DISCORD_TOKEN;
if (token === undefined) {
	throw new Error('DISCORD_TOKEN environment variable is not set');
}

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// When the client is ready, run this code (only once).
client.once(Events.ClientReady, readyClient => {
	console.log(`Ready! Logged in as ${readyClient.user.tag}`);

	readyClient.user.setActivity({
		name: 'you',
		type: ActivityType.Watching,
	});
});

// Log in to Discord
client.login(token);
