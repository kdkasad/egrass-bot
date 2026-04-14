import * as Sentry from "@sentry/bun";
import { EnvService, DiscordService, SignalHandlerService } from "./services";

async function main() {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		enableLogs: true,
		tracesSampleRate: 1.0,
		// Sends Sentry.logger entries to the console
		beforeSendLog(log) {
			const levelMap = {
				critical: console.error,
				fatal: console.error,
				error: console.error,
				warn: console.warn,
				info: console.info,
				debug: console.debug,
				trace: console.trace,
			};
			const consoleFn = levelMap[log.level];
			consoleFn(`[${log.level.toUpperCase()}]`, log.message.toString(), log.attributes);
			return log;
		},
	});

	const env = new EnvService();
	const discord = await DiscordService.new(env);
	const signalHandler = new SignalHandlerService(discord);
}

main();
