import { Database } from "bun:sqlite";

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

// Returns today's date at time 00:00:00, converted to UTC seconds since epoch
function today() {
	let date = new Date();
	date.setHours(0, 0, 0, 0);
	return date.getTime() / 1000; // won't be fractional because we set ms to 0
}

// Returns tomorrow's date at time 00:00:00, converted to UTC seconds since epoch
function tomorrow() {
	return today() + 86_400; // 24 * 60 * 60
}

const getProblemsQuery = db.query(`SELECT url FROM problems WHERE date = ?`);
export function getProblemsForTomorrow(): string[] {
	const rows = getProblemsQuery.all(tomorrow()) as { url: string }[];
	return rows.map((row) => row.url);
}
export function getProblemsForToday(): string[] {
	const rows = getProblemsQuery.all(today()) as { url: string }[];
	return rows.map((row) => row.url);
}

const clearProblemsQuery = db.query(`DELETE FROM problems WHERE date = ?`);
const setProblemsQuery = db.query(
	`INSERT OR IGNORE INTO problems (date, url) VALUES (?, ?)`,
);
export function setProblemsForTomorrow(urls: string[]): void {
	let runTransaction = db.transaction((urls: string[]) => {
		const date = tomorrow();
		clearProblemsQuery.run(date);
		for (const url of urls) {
			// Strip ?list=neetcode150
			url.replace(/\?list=\w*$/, "");
			setProblemsQuery.run(date, url);
		}
	});
	runTransaction(urls);
}
