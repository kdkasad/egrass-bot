import { Service } from "../utils/service";
import { DiscordService } from "./discord";
import * as Sentry from "@sentry/bun";

export class SignalHandlerService extends Service {
	constructor(discord: DiscordService) {
		super();
		["SIGTERM", "SIGINT", "beforeExit"].forEach((signal) => {
			process.on(signal, async (signal) => {
				Sentry.logger.warn("Received signal; exiting...", { signal });
				await discord.stop();
				await Sentry.close();
				process.exit();
			});
		});
	}
}
