import { Events, Guild, Message, User, type Client } from "discord.js";
import { env } from "../../env";
import { Guilds, Roles, Users } from "../../consts";
import { log } from "../../logging";

export function register(client: Client<true>) {
	if (!env.DISABLE_TROLLING) {
		client.on(Events.MessageCreate, handleMessage);
	}
	removeAllPunishments(client);
}

async function removeAllPunishments(client: Client<true>) {
	const guild = await client.guilds.fetch(Guilds.Egrass);
	const role = await guild.roles.fetch(Roles.Punishment);
	if (!role) throw new Error("Punishment role not found");
	await Promise.all(role.members.map((member) => member.roles.remove(role)));
}

async function handleMessage(message: Message) {
	if (
		!message.author.bot &&
		message.author.id !== Users.Kian &&
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
			punishUser(message.author, message.guild),
		]);
	}
}

async function punishUser(user: User, guild: Guild) {
	const member = await guild.members.fetch(user);
	await member.roles.add(Roles.Punishment, "you know what you did");
	log.debug("Punishment role added to user", { userId: user.id });
	setTimeout(async () => {
		await member.roles.remove(Roles.Punishment);
		log.debug("Punishment role removed from user", { userId: user.id });
	}, 6700);
}
