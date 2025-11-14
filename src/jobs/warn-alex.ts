import cron from "node-cron";
import { getProblemsForDay } from "../db";
import { channelMention, type Client } from "discord.js";
import { Channels, Users } from "../consts";
import { env } from "../env";
import { log } from "../logging";

export function createJob(client: Client<true>) {
	if (env.DISABLE_NEETCODE_ANNOUNCEMENTS) return null;
	return cron.schedule(
		"0 22 * * *",
		async () => {
			try {
				await execute(client);
			} catch (error) {
				log.error("Error running warn-alex job", error);
			}
		},
		{ name: "warn-alex" },
	);
}

export async function execute(client: Client<true>) {
	const problems = getProblemsForDay(1);

	if (problems.length > 0) return;

	await client.users.send(Users.Alex, {
		content: `Hey Alex, Mr. Toucher here!
Just letting you know that there are currently no ${channelMention(Channels.Neetcode)} problems selected for tomorrow.`,
	});
}
