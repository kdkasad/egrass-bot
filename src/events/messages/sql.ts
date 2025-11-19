import {
	AttachmentBuilder,
	type Client,
	type Message,
	type OmitPartialGroupDMChannel,
} from "discord.js";
import { log } from "../../logging";
import stringWidth from "string-width";
import {
	MAX_MESSAGE_CREATE_REQUEST_SIZE,
	MAX_MSG_CONTENT_LENGTH,
} from "../../consts";
import { type QueryWorkerResult } from "../../utils";

const QUERY_TIMEOUT_MS = 2000;
const MAX_ATTACHMENT_SIZE = MAX_MESSAGE_CREATE_REQUEST_SIZE - 1024;

export function register(client: Client<true>) {
	client.on("messageCreate", handleMessage);
}

async function handleMessage(
	message: OmitPartialGroupDMChannel<Message<boolean>>,
) {
	// Skip our own messages
	if (message.author.id == message.client.user.id) return;

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
		return;
	}

	// Extract SQL query from message content
	const match = message.content.match(/```sql\n(?<query>.*?)\n```/is);
	if (!match || !match.groups) {
		// Message doesn't contain a SQL code block
		return;
	}
	const query = match.groups.query;

	log.info("SQL query requested", {
		query,
		user: message.author.displayName,
	});

	try {
		const results = await executeReadonlyQuery(query, QUERY_TIMEOUT_MS);
		if (results.length === 0) {
			await message.reply({
				content: `Query returned 0 rows`,
				allowedMentions: { parse: [] },
			});
		} else {
			const table = resultsAsBoxDrawingTable(results);
			const markdown = "```\n" + table + "\n```";
			if (table.length > MAX_ATTACHMENT_SIZE) {
				await message.reply({
					content: `⚠️ Results exceed maximum attachment size (${table.length}>${MAX_ATTACHMENT_SIZE})`,
					allowedMentions: { parse: [] },
				});
			} else if (markdown.length > MAX_MSG_CONTENT_LENGTH) {
				await message.reply({
					content: `ℹ️ Results exceed maximum message content length (${markdown.length}>${MAX_MSG_CONTENT_LENGTH}); using attachment`,
					files: [
						new AttachmentBuilder(Buffer.from(table), {
							name: "results.txt",
						}),
					],
					allowedMentions: { parse: [] },
				});
			} else {
				await message.reply({
					content: markdown,
					allowedMentions: { parse: [] },
				});
			}
		}
	} catch (error) {
		if (error instanceof Error) {
			await message.reply({
				content: `⚠️ Error: ${error.message}`,
				allowedMentions: { parse: [] },
			});
			if (error.name !== "TimeoutError" && error.name !== "SQLiteError") {
				log.error(
					"Error handling SQL request: " + error.message,
					error,
				);
			}
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
	const worker = new Worker("./src/workers/roQuery.ts");
	// Send query to worker
	worker.postMessage(sql);
	const result = await new Promise<QueryWorkerResult>((resolve, reject) => {
		// Kill worker and reject promise after timeout elapses
		const timer = setTimeout(() => {
			worker.terminate();
			reject(new TimeoutError(timeoutMs));
		}, timeoutMs);

		// Handle worker completion message
		worker.addEventListener("message", (message) => {
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
