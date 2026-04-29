import { z } from "zod";
import * as Sentry from "@sentry/bun";

import { Service } from "../utils/service";

const schema = z.object({
	DISCORD_BOT_TOKEN: z.string(),
	SENTRY_DSN: z.url(),
	DATABASE_FILE: z.string(),
	DISABLED_FEATURES: z
		.string()
		.default("")
		.transform((s) => new Set(s.split(","))),
});

export class EnvService extends Service {
	vars!: z.output<typeof schema>;
	constructor() {
		super();
		Sentry.startSpan({ name: `${this._name}.constructor`, op: "function" }, () => {
			this.vars = schema.parse(Bun.env);
			Sentry.logger.info("Environment variables loaded");
		});
		Sentry.logger.info(`${this._name} created`);
	}
}
