// Worker to execute an arbitrary read-only query against the database.

import { rodb } from "../db";
import { log } from "../logging";
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

	// 2. Calculate column widths based on max length of data
	const widths = await new Promise<number[]>((resolve) => {
		const result: number[] = new Array(headers.length).fill(0);
		const processChunk = (start: number) => {
			const chunkEnd = start + CHUNK_SIZE;
			for (let i = 0; i < rows.length && i < chunkEnd; i++) {
				headers.entries().forEach(([colIdx, colName]) => {
					result[colIdx] = Math.max(
						result[colIdx],
						stringWidth(String(rows[i][colName] ?? "")),
					);
				});
			}
			if (chunkEnd >= rows.length) {
				resolve(result);
			} else {
				setTimeout(processChunk, 0, chunkEnd);
			}
		};
		processChunk(0);
	});
	// Expand widths to fit headers if wider than data rows
	headers.entries().forEach(([colIdx, colName]) => {
		// Add 2 for padding (one space on each side)
		widths[colIdx] = Math.max(stringWidth(colName), widths[colIdx]) + 2;
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

	// Helper to pad text (for data - left aligned)
	const pad = (text: string, width: number) => {
		log.debug("pad", { text, width });
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
				setTimeout(processChunk, 0, start + CHUNK_SIZE);
			}
		};
		setTimeout(() => processChunk(0), 0);
	});

	output.push(lines.bottom);

	return output.join("\n");
}
