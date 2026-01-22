import { Events, Guild, Message, User, type Client } from "discord.js";
import { env } from "../../env";
import { Guilds, Roles, Users, Channels } from "../../consts";
import { log } from "../../logging";
import { addMute, removeMute, getMutes } from "../../db";

const SHORT_TIMEOUT_MS = 16700; // 16.7 seconds
const LONG_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function register(client: Client<true>) {
	if (!env.DISABLE_TROLLING) {
		client.on(Events.MessageCreate, handleMessage);
	}
	handleExistingMutes(client);
}

async function handleExistingMutes(client: Client<true>) {
	const now = new Date();
	await Promise.all(
		getMutes().map(async (mute) => {
			if (mute.expiresAt < now) {
				await unmute(mute.userId, client);
			} else {
				const millisUntilExpiry = mute.expiresAt.getTime() - Date.now();
				setTimeout(
					() => unmute(mute.userId, client),
					millisUntilExpiry,
				);
			}
		}),
	);
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
				Math.random() < 0.01
					? "https://tenor.com/view/bee-movie-layton-t-montgomery-monty-montgomery-67-6-7-gif-9758470031245276788"
					: "OMG HAHA SO FUNNY SIX AND SEVEN ARE CONSECUTIVE DIGITS 🤯",
			),
			mute(message.author, message.guild),
		]);
	}
}

async function mute(user: User, guild: Guild) {
	try {
		const member = await guild.members.fetch(user);
		await member.roles.add(Roles.Mute, "you know what you did");

		// 1/667 chance for a whole day timeout heheheha
		const useDayTimeout = Math.random() < 1 / 667;
		const expiresAt = new Date(
			Date.now() + (useDayTimeout ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS),
		);
		addMute(user.id, expiresAt);
		setTimeout(
			() => unmute(user.id, guild.client),
			expiresAt.getTime() - Date.now(),
		);
		log.debug("User muted", {
			userId: user.id,
			expiresAt,
		});
	} catch (error) {
		log.error("Failed to mute user", { userId: user.id, error });
	}
}

async function unmute(userId: string, client: Client<true>) {
	try {
		const guild = await client.guilds.fetch(Guilds.Egrass);
		const member = await guild.members.fetch(userId);
		await member.roles.remove(Roles.Mute);
		removeMute(userId);
		log.debug("User ummuted", { userId });
	} catch (error) {
		log.error(`Failed to remove mute`, { userId, error });
	}
}
