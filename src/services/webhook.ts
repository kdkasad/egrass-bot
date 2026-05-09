import * as Sentry from "@sentry/bun";

import { Feature } from "../utils/service";
import type { EnvService } from "./env";
import { withAssertContentType, withAuth } from "../utils/middleware";
import type { DiscordService } from "./discord";

export class WebhookService extends Feature {
	#server: Bun.Server<undefined> | undefined = undefined;
	#discord: DiscordService;

	constructor(env: EnvService, discord: DiscordService) {
		super(env);
		this.#discord = discord;

		if (this.isEnabled()) {
			this.#server = this.#createServer(env.vars.AUTH_SECRET);
			Sentry.logger.info(Sentry.logger.fmt`${this._name} initialized`);
		} else {
			Sentry.logger.info(Sentry.logger.fmt`${this._name} disabled`);
		}
	}

	#createServer(secret: string) {
		return Bun.serve({
			routes: {
				"/api/status": Response.json({ status: "OK" }),

				// Send message endpoint. Body is Markdown.
				"/api/channels/:channelId/messages": {
					POST: withAuth(
						secret,
						withAssertContentType("text/markdown", async (req) => {
							const content = await req.text();
							try {
								const message = await this.#discord.sendMessage(
									req.params.channelId,
									content,
								);
								return Response.json(message.toJSON());
							} catch (err) {
								Sentry.logger.error(
									Sentry.logger
										.fmt`Creating message failed: ${err instanceof Error ? err.message : err}`,
								);
								Sentry.captureException(err);
								return Response.json(
									{ reason: err instanceof Error ? err.message : String(err) },
									{ status: 500 },
								);
							}
						}),
					),
				},
			},
		});
	}

	async stop() {
		await this.#server?.stop();
		Sentry.logger.info(Sentry.logger.fmt`${this._name} stopped`);
	}
}
