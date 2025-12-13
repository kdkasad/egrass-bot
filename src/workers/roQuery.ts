// Worker to execute an arbitrary read-only query against the database.

import { rodb } from "../db";
import type { QueryWorkerResult } from "../utils";
import stringWidth from "string-width";

declare const self: Worker;

// Wait for initial message with list of bot user IDs
self.addEventListener(
	"message",
	(event) => {
		const sql = event.data as string;
		try {
			const query = rodb.prepare<Record<string, unknown>, []>(sql);
			const results = query.all();
			self.postMessage({
				status: "success",
				table:
					results.length === 0
						? null
						: resultsAsBoxDrawingTable(results),
			} satisfies QueryWorkerResult);
		} catch (thrown) {
			const error =
				thrown instanceof Error ? thrown : new Error(String(thrown));
			self.postMessage({
				status: "error",
				error,
				originalErrorName: error.name,
			} satisfies QueryWorkerResult);
		}
	},
	{ once: true },
);

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
