import { Database, SQLiteError } from "bun:sqlite";
import { getDate } from "./utils";

export interface ProblemPair {
	url1: string;
	url2: string;
}

export const db = new Database("data.sqlite3", { strict: true, create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run(`CREATE TABLE IF NOT EXISTS problems (
	date INTEGER NOT NULL,
	url TEXT UNIQUE NOT NULL
) STRICT`);
console.log("Database initialized");

const getProblemsQuery = db.query(`SELECT url FROM problems WHERE date = ?`);
export function getProblemsForDay(offsetFromToday: number): string[] {
	type Row = { url: string };
	const rows = getProblemsQuery.all(getDate(offsetFromToday)) as Row[];
	return rows.map((row) => row.url);
}

const clearProblemsQuery = db.query(`DELETE FROM problems WHERE date = ?`);
export function clearProblemsForDay(offsetFromToday: number) {
	clearProblemsQuery.run(getDate(offsetFromToday));
}

const setProblemsQuery = db.query(
	`INSERT INTO problems (date, url) VALUES (?, ?)`,
);
export function setProblemsForDay(
	offsetFromToday: number,
	urls: string[],
): void {
	const date = getDate(offsetFromToday);
	let runTransaction = db.transaction((urls: string[], date: number) => {
		clearProblemsQuery.run(date);
		for (const url of urls) {
			// Strip ?list=neetcode150
			url.replace(/\?list=[^/]*$/, "");
			try {
				setProblemsQuery.run(date, url);
			} catch (error) {
				if (
					error instanceof SQLiteError &&
					error.code === "SQLITE_CONSTRAINT_UNIQUE"
				) {
					throw new UniquenessError(
						`Problem ${url} is already in the list`,
						url,
					);
				}
				throw error;
			}
		}
	});
	runTransaction(urls, date);
}

export class UniquenessError extends Error {
	problemUrl: string;

	constructor(message: string, problemUrl: string) {
		super(message);
		this.name = "UniquenessError";
		this.problemUrl = problemUrl;
	}
}

const listQuery = db.query(
	`SELECT date, url FROM problems WHERE date >= ? ORDER BY date ASC`,
);
export function listProblems(includePast: boolean): Map<Date, string[]> {
	type Row = { date: number; url: string };
	const map = new Map();
	let minDate = includePast ? 0 : getDate(0);
	const rows = listQuery.iterate(minDate);
	for (const rawRow of rows) {
		const row = rawRow as Row;
		const date = new Date(row.date * 1000);
		const entry = map.get(date);
		if (entry) {
			entry.push(row.url);
		} else {
			map.set(date, [row.url]);
		}
	}
	return map;
}
