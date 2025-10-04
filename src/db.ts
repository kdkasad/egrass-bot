import { Database } from "bun:sqlite";
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
db.run(
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_problems_date_url ON problems(date, url)`,
);
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
	`INSERT OR IGNORE INTO problems (date, url) VALUES (?, ?)`,
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
			setProblemsQuery.run(date, url);
		}
	});
	runTransaction(urls, date);
}
