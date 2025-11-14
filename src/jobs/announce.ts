import cron from "node-cron";
import { createAnnouncement, getProblemsForDay } from "../db";
import {
	ChannelType,
	MessageFlags,
	TextChannel,
	ThreadAutoArchiveDuration,
	userMention,
	type Client,
} from "discord.js";
import { Channels, Users } from "../consts";
import { extractProblemId, formatProblemUrls } from "../utils";
import { env } from "../env";
import { log } from "../logging";

export function createJob(client: Client<true>) {
	if (env.DISABLE_NEETCODE_ANNOUNCEMENTS) return null;
	return cron.schedule(
		"0 0 * * *",
		async () => {
			try {
				await execute(client);
			} catch (error) {
				log.error("Error running announcement job", error);
			}
		},
		{ name: "announce" },
	);
}

export async function execute(client: Client<true>) {
	const problems = getProblemsForDay(0);

	// Ensure there are problems for today
	if (problems.length === 0) {
		log.warn("No problems found for today");
		await warnAlexAndKian(client);
		return;
	}

	const channel = await getNeetcodeChannel(client);

	// Post & pin message
	const today = new Date();
	const dateString = `${today.getMonth() + 1}/${today.getDate()}`;
	const message = await channel.send({
		content: `# 📆 ${dateString}
## Today's NeetCode problems are:
${formatProblemUrls(problems)}`,
		flags: MessageFlags.SuppressEmbeds,
	});
	await message.pin();

	// Create spoiler threads
	for (const problem of problems) {
		const id = extractProblemId(problem);
		await channel.threads.create({
			name: `${dateString}: ${id} 🧵`,
			autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
			reason: `Spoiler thread for ${id}`,
		});
	}

	// Add to database
	createAnnouncement(message);

	log.info(`Announcement & threads posted`, { today });
}

async function getNeetcodeChannel(client: Client<true>): Promise<TextChannel> {
	// Get #neetcode channel object
	const channel = await client.channels.fetch(Channels.Neetcode);
	if (!channel) {
		throw new Error("#neetcode channel not found");
	}
	if (channel.type !== ChannelType.GuildText) {
		throw new Error("#neetcode channel is not a regular text channel");
	}
	return channel;
}

async function warnAlexAndKian(client: Client<true>) {
	const channel = await getNeetcodeChannel(client);
	await channel.send({
		content: `⚠️ Warning: No problems were found for today.
CC ${userMention(Users.Alex)} ${userMention(Users.Kian)}`,
	});
}
