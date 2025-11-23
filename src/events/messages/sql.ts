import {
	AttachmentBuilder,
	type Client,
	type Message,
	type MessageEditOptions,
	type MessageReplyOptions,
	type OmitPartialGroupDMChannel,
	type PartialMessage,
} from "discord.js";
import { log } from "../../logging";
import stringWidth from "string-width";
import {
	MAX_MESSAGE_CREATE_REQUEST_SIZE,
	MAX_MSG_CONTENT_LENGTH,
} from "../../consts";
import { type QueryWorkerResult } from "../../utils";
import { getResponseToSqlQuery, recordSqlResponse } from "../../db";

const QUERY_TIMEOUT_MS = 5000;
const MAX_ATTACHMENT_SIZE = MAX_MESSAGE_CREATE_REQUEST_SIZE - 1024;

export function register(client: Client<true>) {
	client.on("messageCreate", handleNewMessage);
	client.on("messageUpdate", handleMessgeEdited);
}

/**
 * Returns true if the given message should be checked for a SQL query,
 * or false if it should be ignored.
 */
async function messageIsSqlCandidate(
	message: Message<boolean>,
): Promise<boolean> {
	// Skip our own messages
	if (message.author.id == message.client.user.id) return false;

	// Fetch channel if it is partial
	let channel = message.channel;
	if (channel.partial) channel = await channel.fetch();

	// Only consider messages in DMs or which mention the bot
	if (
		!(
			channel.isDMBased() ||
			message.mentions.parsedUsers.has(message.client.user.id)
		)
	) {
		return false;
	}

	return true;
}

/** Returns the SQL query from the message, or null if it does not contain one */
function getQueryFromMessage(message: Message<boolean>): string | null {
	const match = message.content.match(/```sql\n(?<query>.*?)\n```/is);
	if (!match || !match.groups) {
		// Message doesn't contain a SQL code block
		return null;
	}
	return match.groups.query;
}

async function handleNewMessage(
	message: OmitPartialGroupDMChannel<Message<boolean>>,
) {
	if (!(await messageIsSqlCandidate(message))) return;

	const query = getQueryFromMessage(message);
	if (!query) {
		// Message doesn't contain a SQL code block
		return;
	}

	const responsePayload = await runQueryAndPrepareResponse(query, message);
	const reply = await message.reply(responsePayload);
	recordSqlResponse(message, reply);
}

/** Runs the given SQL query, returning the payload for the response message. */
async function runQueryAndPrepareResponse(
	query: string,
	message: Message,
): Promise<MessageReplyOptions & MessageEditOptions> {
	log.info("SQL query requested", {
		query,
		user: message.author.displayName,
	});

	try {
		const results = await executeReadonlyQuery(query, QUERY_TIMEOUT_MS);
		let replyPayload: MessageReplyOptions & MessageEditOptions;
		if (results.length === 0) {
			replyPayload = { content: `Query returned 0 rows` };
		} else {
			const table = resultsAsBoxDrawingTable(results);
			const markdown = "```\n" + table + "\n```";
			if (table.length > MAX_ATTACHMENT_SIZE) {
				replyPayload = {
					content: `⚠️ Results exceed maximum attachment size (${table.length}>${MAX_ATTACHMENT_SIZE})`,
				};
			} else if (markdown.length > MAX_MSG_CONTENT_LENGTH) {
				replyPayload = {
					content: `ℹ️ Results exceed maximum message content length (${markdown.length}>${MAX_MSG_CONTENT_LENGTH}); using attachment`,
					files: [
						new AttachmentBuilder(Buffer.from(table), {
							name: "results.txt",
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
			if (error.name !== "TimeoutError" && error.name !== "SQLiteError") {
				log.error("Error handling SQL request", error);
			} else if (error.name === "TimeoutError") {
				log.warn("SQL request timed out", {
					query,
					author: message.author.displayName,
					timeoutMs: QUERY_TIMEOUT_MS,
				});
			}
			return {
				content: `⚠️ Error: ${error.message}`,
				allowedMentions: { parse: [] },
			};
		} else {
			throw new Error("unexpected error", { cause: error });
		}
	}
}

// TODO: handle cells with line breaks
function resultsAsBoxDrawingTable(rows: Record<string, unknown>[]): string {
	if (rows.length === 0) throw new Error("Must contain at least one row");

	// 1. Get column headers
	const headers = Object.keys(rows[0]);

	// 2. Calculate column widths based on max length of header vs data
	const widths = headers.map((header) => {
		const maxDataLength = Math.max(
			...rows.map((row) => stringWidth(String(row[header] ?? ""))),
		);
		// Add 2 for padding (one space on each side)
		return Math.max(stringWidth(header), maxDataLength) + 2;
	});

	// Helper to create row lines
	const buildLine = (
		left: string,
		mid: string,
		right: string,
		fill: string,
	) => left + widths.map((w) => fill.repeat(w)).join(mid) + right;

	// Helper to center text (for headers)
	const center = (text: string, width: number) => {
		const space = width - stringWidth(text);
		const left = Math.floor(space / 2);
		return " ".repeat(left) + text + " ".repeat(space - left);
	};

	// Helper to pad text (for data - usually left aligned in SQLite)
	const pad = (text: string, width: number) => {
		return " " + text + " ".repeat(width - stringWidth(text) - 1);
	};

	// Define Box Characters
	const lines = {
		top: buildLine("┌", "┬", "┐", "─"),
		mid: buildLine("├", "┼", "┤", "─"),
		bottom: buildLine("└", "┴", "┘", "─"),
	};

	// Build the Table
	const output = [
		lines.top,
		// Headers (Centered)
		"│" + headers.map((h, i) => center(h, widths[i])).join("│") + "│",
		lines.mid,
		// Data Rows (Left aligned with 1 space padding)
		...rows.map(
			(row) =>
				"│" +
				headers
					.map((h, i) => pad(String(row[h] ?? ""), widths[i]))
					.join("│") +
				"│",
		),
		lines.bottom,
	];

	return output.join("\n");
}

class TimeoutError extends Error {
	constructor(ms: number) {
		super(`Timed out (exceeded ${ms} ms)`);
		this.name = "TimeoutError";
	}
}

async function executeReadonlyQuery(
	sql: string,
	timeoutMs: number,
): Promise<Record<string, unknown>[]> {
	// Create worker
	const worker = new Worker(
		new URL("../../workers/roQuery.ts", import.meta.url),
	);
	log.debug("SQL worker spawned");
	// Send query to worker
	worker.postMessage(sql);
	const result = await new Promise<QueryWorkerResult>((resolve, reject) => {
		// Kill worker and reject promise after timeout elapses
		const timer = setTimeout(() => {
			log.debug("SQL worker timed out");
			worker.terminate();
			reject(new TimeoutError(timeoutMs));
		}, timeoutMs);

		// Handle early worker exit
		worker.addEventListener("close", () => {
			log.debug("SQL worker exited");
			reject(new Error("Worker exited prematurely"));
		});

		// Handle worker completion message
		worker.addEventListener("message", (message) => {
			log.debug("SQL worker sent result message");
			clearTimeout(timer);
			resolve(message.data as QueryWorkerResult);
		});
	});
	if (result.status === "success") {
		return result.results;
	} else {
		// Restore original error name, since structured clone algorithm resets
		// the name of non-builtin errors
		const error = result.error;
		error.name = result.originalErrorName;
		throw error;
	}
}

async function handleMessgeEdited(
	oldMessage: OmitPartialGroupDMChannel<Message> | PartialMessage,
	newMessage: OmitPartialGroupDMChannel<Message>,
) {
	// If new message no longer meets the criteria, skip it
	if (!(await messageIsSqlCandidate(newMessage))) return;

	// If the old message was not a SQL query that we responded to, treat it as a new message
	const originalResponseId = getResponseToSqlQuery(oldMessage.id);
	if (!originalResponseId) {
		return handleNewMessage(newMessage);
	}

	// Fetch the original message so we can check its query
	if (oldMessage.partial) {
		oldMessage = await oldMessage.fetch();
	}

	// Get queries from old and new messages
	const oldQuery = getQueryFromMessage(oldMessage);
	const newQuery = getQueryFromMessage(newMessage);

	// If the new message doesn't contain a query, there's nothing to do
	if (!newQuery) return;

	// If the query hasn't changed, we don't need to do anything
	if (oldQuery === newQuery) return;

	// Get the original response message so we can edit it
	let originalResponse: Message;
	try {
		originalResponse =
			await newMessage.channel.messages.fetch(originalResponseId);
	} catch (error) {
		// If we couldn't fetch the original response, reply to the new message with an error message
		if (error instanceof Error) {
			log.error("Error fetching original response to update", error);
			await newMessage.reply({
				content: `⚠️ Error fetching original response to update`,
				allowedMentions: { parse: [] },
			});
			return;
		} else {
			throw new Error("unexpected error", { cause: error });
		}
	}

	// Run the query
	const responsePayload = await runQueryAndPrepareResponse(
		newQuery,
		newMessage,
	);

	// Edit original response with new results
	try {
		await originalResponse.edit({
			attachments: [],
			...responsePayload,
		});
	} catch (error) {
		// If we couldn't edit the response, reply to the new message with an error message
		if (error instanceof Error) {
			log.error("Error editing original response", error);
			await newMessage.reply({
				content: `⚠️ Error editing original response`,
				allowedMentions: { parse: [] },
			});
			return;
		} else {
			throw new Error("unexpected error", { cause: error });
		}
	}
}
