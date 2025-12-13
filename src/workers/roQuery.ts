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
			(async () => {
				self.postMessage({
					status: "success",
					table:
						results.length === 0
							? null
							: await resultsAsBoxDrawingTable(results),
				} satisfies QueryWorkerResult);
			})();
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
async function resultsAsBoxDrawingTable(
	rows: Record<string, unknown>[],
): Promise<string> {
	const CHUNK_SIZE = 100;

	if (rows.length === 0) throw new Error("Must contain at least one row");

	// 1. Get column headers
	const headers = Object.keys(rows[0]);

	// 2. Calculate column widths based on max length of header vs data
	const widths = await new Promise<number[]>((resolve) => {
		let start = 0;
		let col = 0;
		const result: number[] = new Array(headers.length).fill(0);
		const processChunk = () => {
			if (start >= rows.length) {
				resolve(result);
			}
			let i = 0;
			for (i = 0; i < rows.length && i < start + CHUNK_SIZE; i++) {
				const w = stringWidth(String(rows[i][headers[col]] ?? ""));
				if (w > result[col]) {
					result[col] = w;
				}
			}
			start = i;
			setTimeout(processChunk, 0);
		};
		for (col = 0; col < headers.length; col++) {
			start = 0;
			processChunk();
			// Add 2 for padding (one space on each side)
			result[col] = Math.max(stringWidth(headers[col]), result[col]) + 2;
		}
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

	const output = [
		lines.top,
		// Headers (Centered)
		"│" + headers.map((h, i) => center(h, widths[i])).join("│") + "│",
		lines.mid,
	];

	// Weird annoying dumb stupid chunking logic to yield to the JS runtime every 100 rows so it can listen for
	// termination events
	await new Promise<void>((resolve) => {
		const processChunk = (start: number) => {
			for (
				let i = start;
				i < rows.length && i < start + CHUNK_SIZE;
				i++
			) {
				output.push(
					"│" +
						headers
							.map((h, j) =>
								pad(String(rows[i][h] ?? ""), widths[j]),
							)
							.join("│") +
						"│",
				);
			}
			if (start + CHUNK_SIZE >= rows.length) {
				resolve();
			} else {
				setTimeout(() => processChunk(start + CHUNK_SIZE), 0);
			}
		};
		setTimeout(() => processChunk(0), 0);
	});

	output.push(lines.bottom);

	return output.join("\n");
}
