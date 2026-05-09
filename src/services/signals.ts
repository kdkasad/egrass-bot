import * as Sentry from "@sentry/bun";

import { Service } from "../utils/service";
import type { DiscordService } from "./discord";
import type { DatabaseService } from "./database";
import type { WebhookService } from "./webhook";

export class SignalHandlerService extends Service {
	constructor(discord: DiscordService, database: DatabaseService, webhook: WebhookService) {
		super();
		["SIGTERM", "SIGINT", "beforeExit"].forEach((signal) => {
			process.on(signal, async (signal) => {
				Sentry.logger.warn("Received signal; exiting...", { signal });
				await webhook.stop();
				await discord.stop();
				await database.stop();
				await Sentry.close();
				process.exit();
			});
		});
	}
}
