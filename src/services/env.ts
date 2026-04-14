import { z } from "zod";
import * as Sentry from "@sentry/bun";

import { Service } from "../utils/service";

const schema = z.object({
	DISCORD_BOT_TOKEN: z.string(),
	DISCORD_CLIENT_ID: z.string(),
	DISABLE_NEETCODE_ANNOUNCEMENTS: z.coerce.boolean().default(false),
	MINECRAFT_RCON_HOST: z.string().optional(),
	MINECRAFT_RCON_PORT: z.coerce.number().optional(),
	MINECRAFT_RCON_PASSWORD: z.string().optional(),
	DISABLE_TROLLING: z.coerce.boolean().default(false),
	DISABLE_LOCK_IN: z.coerce.boolean().default(false),
	SENTRY_DSN: z.url(),
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
