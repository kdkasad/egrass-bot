import { logger, startSpan, withIsolationScope } from "@sentry/bun";
import { Service } from "../utils/service";

export class CronService extends Service {
	createJob(
		name: string,
		schedule: Bun.CronWithAutocomplete,
		callback: () => Promise<void>,
	): Bun.CronJob {
		const job = Bun.cron(schedule, () =>
			startSpan(
				{
					name: `cron.job.${name}`,
					op: "cron.job",
					parentSpan: null,
					attributes: {
						"cron.job.schedule": schedule,
						"cron.job.name": name,
					},
				},
				async () => {
					await withIsolationScope(callback);
					logger.info("Cron job completed", {
						"cron.job.schedule": schedule,
						"cron.job.name": name,
						"cron.job.next": Bun.cron.parse(schedule)?.toString(),
					});
				},
			),
		);
		logger.info("Cron job created", {
			"cron.job.schedule": schedule,
			"cron.job.name": name,
			"cron.job.next": Bun.cron.parse(schedule)?.toString(),
		});
		return job;
	}
}
