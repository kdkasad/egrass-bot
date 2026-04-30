import * as Sentry from "@sentry/bun";
import {
	EnvService,
	DiscordService,
	DatabaseService,
	SignalHandlerService,
	ExplodeService,
	TrackingService,
	MarkovService,
	KeywordNotificationService,
	QueryService,
	TrollService,
} from "./services";

async function main() {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		environment: Bun.env.NODE_ENV,
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

	Sentry.logger.info("Bot initializing", {
		environment: Bun.env.NODE_ENV,
	});

	const env = new EnvService();
	const database = await DatabaseService.new(env);
	const discord = await DiscordService.new(env);
	const signalHandler = new SignalHandlerService(discord, database);
	const explode = new ExplodeService(env, discord);
	const tracking = new TrackingService(discord, database);
	const markov = new MarkovService(env, discord, database);
	const keyword = new KeywordNotificationService(env, discord);
	const query = new QueryService(env, discord, database);
	const troll = new TrollService(env, discord, database);
	// Mark as used so nothing complains
	(void signalHandler, explode, tracking, markov, keyword, query, troll);
}

main();
