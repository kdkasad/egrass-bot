import * as Sentry from "@sentry/bun";

import { Feature } from "../../utils/service";
import type { EnvService } from "../env";
import type { DiscordService } from "../discord";
import type { DatabaseService } from "../database";
import { routes } from "./routes";

export class HTTPService extends Feature {
	#server: Bun.Server<undefined> | undefined = undefined;
	#discord: DiscordService;
	#db: DatabaseService;

	constructor(env: EnvService, discord: DiscordService, db: DatabaseService) {
		super(env);
		this.#discord = discord;
		this.#db = db;

		if (this.isEnabled()) {
			this.#server = Bun.serve({
				routes: routes(env.vars.AUTH_SECRET, this.#discord, this.#db),
			});
			Sentry.logger.info(Sentry.logger.fmt`${this._name} initialized`);
		} else {
			Sentry.logger.info(Sentry.logger.fmt`${this._name} disabled`);
		}
	}

	async stop() {
		await this.#server?.stop();
		Sentry.logger.info(Sentry.logger.fmt`${this._name} stopped`);
	}
}
