import cron from "node-cron";
import { getProblemsForToday } from "../db";
import {
	ChannelType,
	MessageFlags,
	ThreadAutoArchiveDuration,
	ThreadChannel,
	type Client,
} from "discord.js";
import { Channels } from "../consts";
import { extractProblemId, formatProblemUrls } from "../utils";

export function createJob(client: Client<true>) {
	cron.schedule("0 0 * * *", async () => {
		try {
			await execute(client);
		} catch (error) {
			console.error("Error running announcement job", error);
		}
	});
}

async function execute(client: Client<true>) {
	const problems = getProblemsForToday();

	// Ensure there are problems for today
	if (problems.length === 0) {
		console.warn("No problems found for today");
		// TODO: DM Alex and/or Kian
		return;
	}

	// Get #neetcode channel object
	const channel = await client.channels.fetch(Channels.Neetcode);
	if (!channel) {
		console.error("#neetcode channel not found");
		return;
	}
	if (channel.type !== ChannelType.GuildText) {
		console.error("#neetcode channel is not a regular text channel");
		return;
	}

	// Post & pin message
	const today = new Date();
	const dateString = `${today.getMonth() + 1}/${today.getDate()}`;
	const message = await channel.send({
		content: `# ${dateString}
## Today's NeetCode problems are:
${formatProblemUrls(problems)}`,
		flags: MessageFlags.SuppressEmbeds,
	});
	await message.pin();

	// Create spoiler threads
	for (const problem of problems) {
		const id = extractProblemId(problem);
		await channel.threads.create({
			name: `${dateString}: ${id}`,
			autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
			reason: `Spoiler thread for ${id}`,
		});
	}
}
