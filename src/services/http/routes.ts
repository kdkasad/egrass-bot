import * as Sentry from "@sentry/bun";
import { sql } from "drizzle-orm";

import type { DiscordService } from "../discord";
import type { DatabaseService } from "../database";
import { withAuth, withAssertContentType } from "../../utils/middleware";

import ReactionGraphHTML from "./static/reaction-graph.html";

type ReactionGraphRow = {
	srcId: string;
	srcName: string;
	dstId: string;
	dstName: string;
	weight: number;
};

export const routes = (secret: string, discord: DiscordService, db: DatabaseService) =>
	({
		"/api/status": Response.json({ status: "OK" }),

		// Send message endpoint. Body is Markdown.
		"/api/channels/:channelId/messages": {
			POST: withAuth(
				secret,
				withAssertContentType("text/markdown", async (req) => {
					const content = await req.text();
					try {
						const message = await discord.sendMessage(req.params.channelId, content);
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

		"/reaction-graph/": ReactionGraphHTML,

		"/api/guilds/:guildId/reaction-graph": async (req) => {
			try {
				const rows = await db.query("reaction graph", async (tx) => {
					return tx.all<ReactionGraphRow>(sql`
						SELECT
							reactions.user_id AS srcId,
							messages.author_id AS dstId,
							mdst.display_name AS dstName,
							msrc.display_name AS srcName,
							COUNT(*) AS weight
						FROM reactions
						JOIN messages ON messages.id = reactions.message_id
						JOIN members AS mdst ON mdst.id = messages.author_id
						JOIN members AS msrc ON msrc.id = reactions.user_id
						WHERE messages.guild_id = ${req.params.guildId}
						GROUP BY srcId, dstId
					`);
				});
				return Response.json(rows, {
					headers: {
						"Cache-Control": "public, max-age=3600",
					},
				});
			} catch (err) {
				Sentry.logger.error(
					Sentry.logger
						.fmt`Failed to generate reaction graph: ${err instanceof Error ? err.message : err}`,
				);
				Sentry.captureException(err);
				return Response.json(
					{ reason: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		},
	}) satisfies Parameters<typeof Bun.serve>[0]["routes"];
