import {
	type Client,
	type Message,
	type OmitPartialGroupDMChannel,
} from "discord.js";
import { executeReadonlyQuery, TooManyRowsError } from "../../db";
import { log } from "../../logging";
import { SQLiteError } from "bun:sqlite";
import stringWidth from "string-width";
import { MAX_MSG_CONTENT_LENGTH } from "../../consts";

const MAX_ROWS = 100;

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
	const match = message.content.match(/```sql\n(?<query>.*?)\n```/i);
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
		const results = executeReadonlyQuery(query, MAX_ROWS);
		if (results.length === 0) {
			await message.reply({
				content: `Query returned 0 rows`,
				allowedMentions: { parse: [] },
			});
		} else {
			const content = resultsAsMarkdown(results);
			if (content.length > MAX_MSG_CONTENT_LENGTH) {
				await message.reply({
					content: `Resulting table is too long to fit in one Discord message (limit is ${MAX_MSG_CONTENT_LENGTH} chars, have ${content.length})`,
					allowedMentions: { parse: [] },
				});
			} else {
				await message.reply({
					content: resultsAsMarkdown(results),
					allowedMentions: { parse: [] },
				});
			}
		}
	} catch (error) {
		if (error instanceof Error) {
			let content = `⚠️ Error: ${error.message}`;
			if (error instanceof TooManyRowsError) {
				content += "\nConsider adding a `LIMIT` clause to the query.";
			}
			await message.reply({
				content,
				allowedMentions: { parse: [] },
			});
			if (
				!(
					error instanceof TooManyRowsError ||
					error instanceof SQLiteError
				)
			) {
				log.error(error.message, error);
			}
		}
	}
}

function resultsAsMarkdown(results: Record<string, unknown>[]): string {
	return "```\n" + resultsAsBoxDrawingTable(results) + "\n```";
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
