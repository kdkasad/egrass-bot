import type { Client } from "discord.js";

import * as announce from "./announce";
import * as warnAlex from "./warn-alex";

export interface Job {
	createJob(client: Client<true>): void;
}

export const jobs: Job[] = [announce, warnAlex];
