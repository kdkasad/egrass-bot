import type { Client } from "discord.js";

import * as announce from "./announce";

export interface Job {
	createJob(client: Client<true>): void;
}

export const jobs: Job[] = [announce];
