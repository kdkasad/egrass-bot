import { Database, SQLiteError } from "bun:sqlite";
import { getDate } from "./utils";
import type { Message, PartialMessage, PartialUser, User } from "discord.js";

export interface ProblemPair {
	url1: string;
	url2: string;
}

export const db = new Database("data.sqlite3", { strict: true, create: true });
console.log("Created database");
// db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON");
db.run(`CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY NOT NULL
) STRICT`);
const version =
	(
		db.prepare("SELECT version FROM schema_version").get() as {
			version: number;
		} | null
	)?.version ?? 0;
if (version < 1) {
	db.run(`INSERT INTO schema_version (version) VALUES (1)`);
	db.run(`CREATE TABLE IF NOT EXISTS problems (
		date INTEGER NOT NULL,
		url TEXT UNIQUE NOT NULL
	) STRICT`);
	db.run("CREATE INDEX IF NOT EXISTS idx_problems_date ON problems(date)");
	db.run(`CREATE TABLE IF NOT EXISTS announcements (
		message_id TEXT PRIMARY KEY NOT NULL,
		date INTEGER UNIQUE NOT NULL
	) STRICT`);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_announcements_date ON announcements(date)",
	);
	db.run(`CREATE TABLE IF NOT EXISTS solves (
		user_id TEXT NOT NULL,
		solve_time INTEGER NOT NULL,
		announcement_id TEXT NOT NULL,
		FOREIGN KEY (announcement_id) REFERENCES announcements(message_id)
	) STRICT`);
	db.run("CREATE INDEX IF NOT EXISTS idx_solves_user_id ON solves(user_id)");
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_solves_announcement_id ON solves(announcement_id)",
	);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_solves_user_id_announcement_id ON solves(user_id, announcement_id)",
	);
	console.debug("Applied migration 1");
}
console.log("Database initialization complete");

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
	const runTransaction = db.transaction((urls: string[], date: number) => {
		clearProblemsQuery.run(date);
		for (const rawUrl of urls) {
			// Strip ?list=neetcode150
			const url = rawUrl.replace(/\?list=[^/]*$/, "");
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
	// Map using seconds since epoch as the keys, since Date objects don't equal each other
	const epochMap: Map<number, string[]> = new Map();
	const minDate = includePast ? 0 : getDate(0);
	const rows = listQuery.iterate(minDate);
	for (const rawRow of rows) {
		const row = rawRow as Row;
		const entry = epochMap.get(row.date);
		if (entry) {
			entry.push(row.url);
		} else {
			epochMap.set(row.date, [row.url]);
		}
	}
	const dateMap: Map<Date, string[]> = new Map();
	for (const [epoch, urls] of epochMap) {
		dateMap.set(new Date(epoch * 1000), urls);
	}
	return dateMap;
}

const createAnnouncementQuery = db.query(
	"INSERT INTO announcements (message_id, date) VALUES (?, ?)",
);
export function createAnnouncement(message: Message) {
	createAnnouncementQuery.run(message.id, getDate(0));
}

const recordSolveQuery = db.query(
	"INSERT INTO solves (user_id, announcement_id, solve_time) VALUES (?, ?, ?)",
);
const getSolveCountQuery = db.query(
	`SELECT COUNT(*) AS "count" FROM solves WHERE announcement_id = ?`,
);
/** @returns true if the solve being recorded is the first solve for the announcement */
export function recordSolve(
	user: User | PartialUser,
	announcement: Message | PartialMessage,
): boolean {
	type Row = { count: number };
	const now = Math.floor(Date.now() / 1000);
	const row = db.transaction(() => {
		recordSolveQuery.run(user.id, announcement.id, now);
		return getSolveCountQuery.get(announcement.id) as Row;
	})();
	return row.count === 1;
}

const deleteSolveQuery = db.query(
	"DELETE FROM solves WHERE user_id = ? AND announcement_id = ? RETURNING solve_time",
);
const getFirstSolveQuery = db.query(
	`SELECT user_id, solve_time FROM solves WHERE announcement_id = ? ORDER BY solve_time ASC LIMIT 1`,
);
export type FirstSolveUpdate = {
	/** Whether the first solve has changed */
	changed: boolean;
	/** The user ID of the new first solver, or null if there is no first solve now */
	userId: string | null;
};
export function deleteSolve(
	user: User | PartialUser,
	announcement: Message | PartialMessage,
): FirstSolveUpdate {
	type DeleteRow = { user_id: string; solve_time: number } | null;
	type GetRow = { user_id: string; solve_time: number } | null;
	return db.transaction(() => {
		const del = deleteSolveQuery.get(user.id, announcement.id) as DeleteRow;
		const get = getFirstSolveQuery.get(announcement.id) as GetRow;
		return {
			changed:
				del === null
					? false
					: get === null || del.solve_time < get.solve_time,
			userId: get?.user_id ?? null,
		};
	})();
}

const lookupAnnouncementQuery = db.query(
	"SELECT 1 FROM announcements WHERE message_id = ?",
);
export function isPastAnnouncement(messageId: string): boolean {
	return !!lookupAnnouncementQuery.get(messageId);
}

export interface UserStats {
	/** Total number of days solved */
	solves: number;
	/** Number of days for which the user got the first solve */
	firstSolves: number;
	/** Longest number of consecutive days for which the user solved the problem within 24 hours */
	longestStreak: number;
}
const getUserSolveCountQuery = db.query<{ count: number }, [string]>(
	`SELECT COUNT(*) as "count" FROM solves WHERE user_id = ?`,
);
const getUserFirstSolveCountQuery = db.query<{ count: number }, [string]>(
	// Note: this query uses SQLite-specific behavior regarding MIN() and GROUP BY.
	// See https://sqlite.org/lang_select.html#bare_columns_in_an_aggregate_query
	`WITH first_solves AS (
		SELECT user_id, MIN(solve_time) as solve_time
		FROM solves
		GROUP BY announcement_id
	)
	SELECT COUNT(*) as "count"
	FROM first_solves
	WHERE user_id = ?`,
);
const getUserLongestStreakQuery = db.query<{ length: number }, [string]>(
	`WITH valid_solves AS (
		SELECT announcements.date
		FROM solves
		JOIN announcements ON solves.announcement_id = announcements.message_id
		WHERE solves.user_id = ?
	),
	streak_groups AS (
		SELECT
			date,
			(date - (ROW_NUMBER() OVER (ORDER BY date)) * 86400) AS "group"
		FROM valid_solves
	),
	streaks AS (
		SELECT COUNT(*) as length FROM streak_groups GROUP BY "group"
	)
	SELECT MAX(length) as length FROM streaks`,
);
export function getStats(user: User | PartialUser): UserStats {
	return {
		solves: getUserSolveCountQuery.get(user.id)?.count ?? 0,
		firstSolves: getUserFirstSolveCountQuery.get(user.id)?.count ?? 0,
		longestStreak: getUserLongestStreakQuery.get(user.id)?.length ?? 0,
	};
}
