// Worker to execute an arbitrary read-only query against the database.
//
// Reads a JSON-encoded QueryWorkerRequest from stdin.
//
// Exit status of 0 is success, non-zero is failure.
// On success, the formatted result is written to stdout.
// On error, a JSON-encoded QueryWorkerError is written to stdout.

import { Database } from "bun:sqlite";
import { type QueryWorkerError, type QueryWorkerRequest, QueryResultFormat } from "../types/query";
import stringWidth from "string-width";

async function main() {
	try {
		const { sql, format, dbFile } = JSON.parse(await Bun.stdin.text()) as QueryWorkerRequest;
		const rodb = new Database(dbFile, { readonly: true, readwrite: false });
		let results: Record<string, unknown>[];
		try {
			rodb.run("PRAGMA query_only = 1;");
			const query = rodb.prepare<Record<string, unknown>, []>(sql);
			try {
				results = query.all();
			} finally {
				query.finalize();
			}
		} finally {
			rodb.close();
		}
		if (results.length === 0) return;
		await Bun.write(Bun.stdout, formatResults(results, format));
	} catch (thrown) {
		const error = thrown instanceof Error ? thrown : new Error(String(thrown));
		await Bun.write(
			Bun.stdout,
			JSON.stringify({ name: error.name, message: error.message } satisfies QueryWorkerError),
		);
		process.exitCode = 1;
	}
}

type Formatter = (rows: Record<string, unknown>[]) => string;

function formatResults(rows: Record<string, unknown>[], format: QueryResultFormat): string {
	const formatters: Record<QueryResultFormat, Formatter> = {
		[QueryResultFormat.Table]: resultsAsBoxDrawingTable,
		[QueryResultFormat.JSON]: resultsAsJSON,
	};
	return formatters[format](rows);
}

const resultsAsJSON: Formatter = (rows) => {
	return JSON.stringify(rows);
};

// TODO: handle cells with line breaks
const resultsAsBoxDrawingTable: Formatter = (rows) => {
	if (rows.length === 0) throw new Error("Must contain at least one row");

	// 1. Get column headers
	const headers = Object.keys(rows[0]);

	// 2. Calculate column widths based on max length of data
	const widths: number[] = new Array(headers.length).fill(0);
	for (const row of rows) {
		for (const [colIdx, colName] of headers.entries()) {
			widths[colIdx] = Math.max(widths[colIdx], stringWidth(String(row[colName] ?? "")));
		}
	}
	// Expand widths to fit headers if wider than data rows
	headers.entries().forEach(([colIdx, colName]) => {
		// Add 2 for padding (one space on each side)
		widths[colIdx] = Math.max(stringWidth(colName), widths[colIdx]) + 2;
	});

	// Helper to create row lines
	const buildLine = (left: string, mid: string, right: string, fill: string) =>
		left + widths.map((w) => fill.repeat(w)).join(mid) + right;

	// Helper to center text (for headers)
	const center = (text: string, width: number) => {
		const space = width - stringWidth(text);
		const left = Math.floor(space / 2);
		return " ".repeat(left) + text + " ".repeat(space - left);
	};

	// Helper to pad text (for data - left aligned)
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
	for (const row of rows) {
		output.push(
			"│" + headers.map((h, j) => pad(String(row[h] ?? ""), widths[j])).join("│") + "│",
		);
	}
	output.push(lines.bottom);
	return output.join("\n");
};

main();
