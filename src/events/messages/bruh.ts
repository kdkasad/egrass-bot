import { Events, Guild, Message, User, type Client } from "discord.js";
import { env } from "../../env";
import { Guilds, Roles, Users, Channels } from "../../consts";
import { log } from "../../logging";
import { addDayTimeout, removeDayTimeout, getExpiredDayTimeouts } from "../../db";

const TIMEOUT_MS = 16700; // 16.7 seconds
const DAY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function register(client: Client<true>) {
	if (!env.DISABLE_TROLLING) {
		client.on(Events.MessageCreate, handleMessage);
	}
	removeAllPunishments(client);
	setInterval(checkTimeouts, 60000, client);
}

async function checkTimeouts(client: Client<true>) {
	try {
		const guild = await client.guilds.fetch(Guilds.Egrass);
		const role = await guild.roles.fetch(Roles.Punishment);
		if (!role) return;
		const expiredTimeouts = getExpiredDayTimeouts();
		for (const timeout of expiredTimeouts) {
			try {
				const member = await guild.members.fetch(timeout.user_id);
				await member.roles.remove(Roles.Punishment);
				removeDayTimeout(timeout.user_id, timeout.guild_id);
				log.info("Removed expired day timeout", { 
					userId: timeout.user_id, 
					guildId: timeout.guild_id 
				});
			} catch (error) {
				log.warn("Failed to remove expired timeout", { 
					error: (error as Error).message,
					userId: timeout.user_id 
				});
				removeDayTimeout(timeout.user_id, timeout.guild_id);
			}
		}
	} catch (error) {
		log.error("Error checking expired timeouts", { error: (error as Error).message });
	}
}

async function removeAllPunishments(client: Client<true>) {
	const guild = await client.guilds.fetch(Guilds.Egrass);
	const role = await guild.roles.fetch(Roles.Punishment);
	if (!role) throw new Error("Punishment role not found");
	await Promise.all(role.members.map((member) => member.roles.remove(role)));
	await checkTimeouts(client);
}

async function handleMessage(message: Message) {
	if (
		!message.author.bot &&
		message.author.id !== Users.Kian &&
		message.channelId !== Channels.Announcements &&
		message.inGuild() &&
		message.content.match(
			/(?:\b(?:6+|six)\b.*\b(?:7+|seven)\b)|(?:\b6+7+\b)/i,
		)
	) {
		await Promise.all([
			message.react("🥀"),
			message.reply(
				Math.random() < 0.067
					? "https://tenor.com/view/bee-movie-layton-t-montgomery-monty-montgomery-67-6-7-gif-9758470031245276788"
					: "OMG HAHA SO FUNNY SIX AND SEVEN ARE CONSECUTIVE DIGITS 🤯",
			),
			punishUser(message.author, message.guild),
		]);
	}
}

async function punishUser(user: User, guild: Guild) {
	const member = await guild.members.fetch(user);
	await member.roles.add(Roles.Punishment, "you know what you did");
	log.debug("Punishment role added to user", { userId: user.id });
	
	// 1/667 chance for a whole day timeout heheheha
	const useDayTimeout = Math.random() < 1 / 667;
	if (useDayTimeout) {
		const expiresAt = Math.floor((Date.now() + DAY_TIMEOUT_MS) / 1000);
		addDayTimeout(user.id, guild.id, expiresAt);
		log.info("Day punishment rule added to user", { userId: user.id, expiresAt });
		setTimeout(async () => {
			await member.roles.remove(Roles.Punishment);
			log.debug("Punishment role removed from user (short timeout)", { userId: user.id });
		}, TIMEOUT_MS);
	} else {
		// Regular short timeout
		setTimeout(async () => {
			await member.roles.remove(Roles.Punishment);
			log.debug("Punishment role removed from user", { userId: user.id });
		}, TIMEOUT_MS);
	}
}
