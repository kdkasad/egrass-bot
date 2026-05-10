import * as Sentry from "@sentry/bun";

import { Service } from "../utils/service";
import type { DiscordService } from "./discord";
import type { DatabaseService } from "./database";
import type { HTTPService } from "./http";

export class SignalHandlerService extends Service {
	constructor(discord: DiscordService, database: DatabaseService, http: HTTPService) {
		super();
		["SIGTERM", "SIGINT", "beforeExit"].forEach((signal) => {
			process.on(signal, async (signal) => {
				Sentry.logger.warn("Received signal; exiting...", { signal });
				await http.stop();
				await discord.stop();
				await database.stop();
				await Sentry.close();
				process.exit();
			});
		});
	}
}
