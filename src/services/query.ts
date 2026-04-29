import * as Sentry from "@sentry/bun";
import {
	AttachmentBuilder,
	type Message,
	type MessageEditOptions,
	type MessageReplyOptions,
	type OmitPartialGroupDMChannel,
	type PartialMessage,
} from "discord.js";
import { eq } from "drizzle-orm";

import { Feature } from "../utils/service";
import type { DatabaseService } from "./database";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";
import { editMessage, replyToMessage, traced } from "../utils/tracing";
import { QueryResultFormat, type QueryWorkerRequest, type QueryWorkerResult } from "../types/query";
import { MAX_MESSAGE_CREATE_REQUEST_SIZE, MAX_MSG_CONTENT_LENGTH } from "../consts";
import { sql_responses } from "../db/schema";

const QUERY_TIMEOUT_MS = 5000;
const MAX_ATTACHMENT_SIZE = MAX_MESSAGE_CREATE_REQUEST_SIZE - 1024;

export class TimeoutError extends Error {
	constructor(ms: number) {
		super(`Timed out (exceeded ${ms} ms)`);
	}
}

export class QueryService extends Feature {
	#db: DatabaseService;
	constructor(env: EnvService, discord: DiscordService, database: DatabaseService) {
		super(env);
		this.#db = database;
		if (this.isEnabled()) {
			discord.subscribe("message:create", (msg) => this.#handleNewMessage(msg));
			discord.subscribe("message:edit", (oldMsg, newMsg) =>
				this.#handleEditedMessage(oldMsg, newMsg),
			);
			Sentry.logger.info(`${this._name} initialized`, {
				"service.name": this._name,
			});
		} else {
			Sentry.logger.info(`${this._name} disabled`, {
				"service.name": this._name,
			});
		}
	}

	@traced("event.handler")
	async #handleNewMessage(message: OmitPartialGroupDMChannel<Message>) {
		if (!this.#isSqlCandidate(message)) return;

		const query = this.#getQueryFromMessage(message);
		if (!query) {
			return;
		}

		const responsePayload = await this.#runQueryAndPrepareResponse(query, message);
		const reply = await replyToMessage(message, responsePayload);
		// Record response in database
		this.#db.query("insert query response message", (tx) =>
			tx.insert(sql_responses).values({
				query_id: message.id,
				response_id: reply.id,
			}),
		);
	}

	@traced("event.handler")
	async #handleEditedMessage(
		oldMessage: OmitPartialGroupDMChannel<Message> | PartialMessage,
		newMessage: OmitPartialGroupDMChannel<Message>,
	) {
		// If new message no longer meets the criteria, skip it
		if (!this.#isSqlCandidate(newMessage)) return;

		// If the old message was not a SQL query that we responded to, treat it as a new message
		const result = await this.#db.query("select query response", (tx) =>
			tx
				.select({ responseId: sql_responses.response_id })
				.from(sql_responses)
				.where(eq(sql_responses.query_id, oldMessage.id)),
		);
		const originalResponseId = result[0]?.responseId ?? null;
		if (!originalResponseId) {
			return this.#handleNewMessage(newMessage);
		}

		// Fetch the original message so we can check its query
		if (oldMessage.partial) {
			oldMessage = await oldMessage.fetch();
		}

		// Get queries from old and new messages
		const oldQuery = this.#getQueryFromMessage(oldMessage)!;
		const newQuery = this.#getQueryFromMessage(newMessage);

		// If the new message doesn't contain a query, there's nothing to do
		if (!newQuery) return;

		// If the query hasn't changed, we don't need to do anything
		if (oldQuery.sql === newQuery.sql && oldQuery.format === newQuery.format) {
			return;
		}

		// Get the original response message so we can edit it
		let originalResponse: Message;
		try {
			originalResponse = await newMessage.channel.messages.fetch(originalResponseId);
		} catch (error) {
			Sentry.captureException(error);
			// If we couldn't fetch the original response, reply to the new message with an error message
			if (error instanceof Error) {
				Sentry.logger.error(
					Sentry.logger.fmt`Error fetching original response to update: ${error.message}`,
				);
				await replyToMessage(newMessage, {
					content: `⚠️ Error fetching original response to update`,
					allowedMentions: { parse: [] },
				});
			}
			return;
		}

		// Run the query
		const responsePayload = await this.#runQueryAndPrepareResponse(newQuery, newMessage);

		// Edit original response with new results
		try {
			await editMessage(originalResponse, {
				attachments: [],
				...responsePayload,
			});
		} catch (error) {
			Sentry.captureException(error);
			// If we couldn't edit the response, reply to the new message with an error message
			if (error instanceof Error) {
				Sentry.logger.error(
					Sentry.logger.fmt`Error editing original response: ${error.message}`,
				);
				await replyToMessage(newMessage, {
					content: `⚠️ Error editing original response`,
					allowedMentions: { parse: [] },
				});
			}
			return;
		}
	}

	async #runQueryAndPrepareResponse(
		query: QueryWorkerRequest,
		message: Message,
	): Promise<MessageReplyOptions & MessageEditOptions> {
		Sentry.getCurrentScope().setAttributes({
			"query.sql": query.sql,
			"query.format": query.format,
			"user.id": message.author.id,
			"user.name": message.author.displayName,
			"timeout.ms": QUERY_TIMEOUT_MS,
		});
		Sentry.logger.info("SQL query requested");
		try {
			const result = await this.#executeReadonlyQuery(query, QUERY_TIMEOUT_MS);
			let replyPayload: MessageReplyOptions & MessageEditOptions;
			if (result === null) {
				replyPayload = { content: `Query returned 0 rows` };
			} else {
				const markdown = "```\n" + result + "\n```";
				if (result.length > MAX_ATTACHMENT_SIZE) {
					replyPayload = {
						content: `⚠️ Results exceed maximum attachment size (${result.length}>${MAX_ATTACHMENT_SIZE})`,
					};
				} else if (markdown.length > MAX_MSG_CONTENT_LENGTH) {
					const attachmentFilename: Record<QueryResultFormat, string> = {
						[QueryResultFormat.JSON]: "results.json",
						[QueryResultFormat.Table]: "results.txt",
					} as const;
					replyPayload = {
						content: `ℹ️ Results exceed maximum message content length (${markdown.length}>${MAX_MSG_CONTENT_LENGTH}); using attachment`,
						files: [
							new AttachmentBuilder(Buffer.from(result), {
								name: attachmentFilename[query.format],
							}),
						],
					};
				} else {
					replyPayload = { content: markdown };
				}
			}
			return {
				...replyPayload,
				allowedMentions: { parse: [] },
			};
		} catch (error) {
			if (error instanceof Error) {
				if (error.name !== TimeoutError.name && error.name !== Bun.SQL.SQLiteError.name) {
					Sentry.captureException(error);
					Sentry.logger.error(
						Sentry.logger.fmt`Error handling SQL request: ${error.message}`,
					);
				} else if (error.name === TimeoutError.name) {
					Sentry.logger.warn("SQL request timed out");
				}
				return {
					content: `⚠️ Error: ${error.message}`,
					allowedMentions: { parse: [] },
				};
			} else {
				Sentry.captureException(error);
				return {
					content: `⚠️ Error: ${String(error)}`,
					allowedMentions: { parse: [] },
				};
			}
		}
	}

	@traced("worker.spawn")
	async #executeReadonlyQuery(
		query: QueryWorkerRequest,
		timeoutMs: number,
	): Promise<string | null> {
		const worker = new Worker(new URL("../workers/query.ts", import.meta.url));
		Sentry.logger.info("SQL worker spawned");
		// Send query to worker
		worker.postMessage(query satisfies QueryWorkerRequest);
		const result = await new Promise<QueryWorkerResult>((resolve, reject) => {
			// Kill worker and reject promise after timeout elapses
			const timer = setTimeout(() => {
				Sentry.logger.info("SQL worker timed out");
				worker.terminate();
				reject(new TimeoutError(timeoutMs));
			}, timeoutMs);

			// Handle early worker exit
			worker.addEventListener("close", () => {
				Sentry.logger.info("SQL worker exited");
				reject(new Error("Worker exited prematurely"));
			});

			// Handle worker completion message
			worker.addEventListener("message", (message) => {
				Sentry.logger.info("SQL worker sent result message");
				clearTimeout(timer);
				resolve(message.data as QueryWorkerResult);
			});
		});
		if (result.status === "success") {
			return result.formattedResult;
		} else {
			// Restore the original error name, since the structured clone
			// algorithm resets the name of non-built-in errors.
			const error = result.error;
			error.name = result.originalErrorName;
			throw error;
		}
	}

	#isSqlCandidate(message: Message): boolean {
		// Skip our own messages
		if (message.author.id == message.client.user.id) return false;

		// Only consider messages in DMs or which mention the bot
		if (
			!(
				message.channel.isDMBased() ||
				message.mentions.parsedUsers.has(message.client.user.id)
			)
		) {
			return false;
		}

		return true;
	}

	#getQueryFromMessage(message: Message): QueryWorkerRequest | null {
		const match = message.content.match(/```sql\n(?<query>.*?)\n```/is);
		if (!match || !match.groups) {
			// Message doesn't contain a SQL code block
			return null;
		}
		const format = message.content.trimEnd().toLowerCase().endsWith("json")
			? QueryResultFormat.JSON
			: QueryResultFormat.Table;
		return { sql: match.groups.query, format, dbFile: this.#db.dbFilename };
	}
}
