import * as Sentry from "@sentry/bun";

import { Guilds, Roles, Users } from "../consts";
import { traced } from "../utils/tracing";
import { Feature } from "../utils/service";
import type { CronService } from "./cron";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";

const EASTERN_TIMEZONE = "America/New_York";
const NIGHTTIME_MUTE_START_HOUR = 23;
const NIGHTTIME_MUTE_END_HOUR = 5;

export class NighttimeMuteService extends Feature {
	#discord: DiscordService;
	#cron: CronService;

	constructor(env: EnvService, discord: DiscordService, cron: CronService) {
		super(env);
		this.#discord = discord;
		this.#cron = cron;

		if (this.isEnabled()) {
			this.#cron.createJob(
				"nighttime-mute.start",
				"0 23 * * *",
				() => this.#applyRestriction(),
				{ timezone: EASTERN_TIMEZONE },
			);
			this.#cron.createJob(
				"nighttime-mute.end",
				"0 5 * * *",
				() => this.#removeRestriction(),
				{ timezone: EASTERN_TIMEZONE },
			);
			void this.#syncRestriction();
			Sentry.logger.info(`${this._name} initialized`);
		} else {
			Sentry.logger.info(`${this._name} disabled`);
		}
	}

	@traced()
	async #applyRestriction() {
		try {
			const guild = await this.#discord.client.guilds.fetch(Guilds.Egrass);
			const member = await guild.members.fetch(Users.Triple_T);
			await member.roles.add(Roles.NighttimeMute, "nighttime restriction started");
			Sentry.logger.info("Nighttime restriction applied", { "user.id": Users.Triple_T });
		} catch (err) {
			Sentry.logger.error(
				Sentry.logger.fmt`Failed to apply nighttime restriction to ${Users.Triple_T}: ${err instanceof Error ? err.message : String(err)}`,
			);
			Sentry.captureException(err);
		}
	}

	@traced()
	async #removeRestriction() {
		try {
			const guild = await this.#discord.client.guilds.fetch(Guilds.Egrass);
			const member = await guild.members.fetch(Users.Triple_T);
			await member.roles.remove(Roles.NighttimeMute, "nighttime restriction ended");
			Sentry.logger.info("Nighttime restriction removed", { "user.id": Users.Triple_T });
		} catch (err) {
			Sentry.logger.error(
				Sentry.logger.fmt`Failed to remove nighttime restriction from ${Users.Triple_T}: ${err instanceof Error ? err.message : String(err)}`,
			);
			Sentry.captureException(err);
		}
	}

	@traced()
	async #syncRestriction() {
		const easternHour = Number(
			new Intl.DateTimeFormat("en-US", {
				timeZone: EASTERN_TIMEZONE,
				hour: "numeric",
				hourCycle: "h23",
			}).format(new Date()),
		);

		if (easternHour >= NIGHTTIME_MUTE_START_HOUR || easternHour < NIGHTTIME_MUTE_END_HOUR) {
			await this.#applyRestriction();
		} else {
			await this.#removeRestriction();
		}
	}
}
