import type { Client } from "discord.js";
import type { ScheduledTask } from "node-cron";

import * as announce from "./announce";
import * as warnAlex from "./warn-alex";

export interface Job {
	createJob(client: Client<true>): ScheduledTask | null;
}

export const jobs: Job[] = [announce, warnAlex];
