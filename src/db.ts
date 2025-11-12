import { Database, SQLiteError } from "bun:sqlite";
import { getDate } from "./utils";
import {
	messageLink,
	type Message,
	type PartialMessage,
	type PartialUser,
	type User,
} from "discord.js";
import type { QuoteCategories } from "./consts";

export interface ProblemPair {
	url1: string;
	url2: string;
}

export interface ProblemsRow {
	date: number;
	url: string;
}

export interface SolvesRow {
	user_id: string;
	solve_time: number;
	announcement_id: string;
}

export interface AnnouncementsRow {
	message_id: string;
	date: number;
}

interface SchemaVersionRow {
	version: number;
}

export interface QuoteRow {
	category: QuoteCategories;
	guild_id: string;
	channel_id: string;
	message_id: string;
	quote: string;
	author_user_id: string;
	timestamp: number;
}

export interface MessageRow {
	id: string;
	guild_id: string;
	channel_id: string;
	author_id: string;
	timestamp: number;
	content: string;
}

export interface Markov4Row {
	message_id: MessageRow["id"];
	word1: string | null;
	word2: string | null;
	word3: string | null;
	word4: string | null;
	word5: string | null;
}

export const db = new Database("data.sqlite3", { strict: true, create: true });
console.log("Created database");
// db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON");
db.run(`CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY NOT NULL
) STRICT`);
const version =
	db.prepare<SchemaVersionRow, []>("SELECT version FROM schema_version").get()
		?.version ?? 0;
if (version < 1) {
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
	db.run(`INSERT INTO schema_version (version) VALUES (1)`);
	console.debug("Applied migration 1");
}
if (version < 2) {
	// Remove NOT NULL constraint from solves.solve_time
	db.run(`ALTER TABLE solves RENAME to solves_old`);
	db.run(`CREATE TABLE solves (
		user_id TEXT NOT NULL,
		solve_time INTEGER,
		announcement_id TEXT NOT NULL,
		FOREIGN KEY (announcement_id) REFERENCES announcements(message_id)
	) STRICT`);
	db.run(`INSERT INTO solves (user_id, solve_time, announcement_id)
		SELECT user_id, solve_time, announcement_id FROM solves_old`);
	db.run(`DROP TABLE solves_old`);
	// Re-create indexes for new table
	db.run("CREATE INDEX IF NOT EXISTS idx_solves_user_id ON solves(user_id)");
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_solves_announcement_id ON solves(announcement_id)",
	);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_solves_user_id_announcement_id ON solves(user_id, announcement_id)",
	);
	db.run(`UPDATE schema_version SET version = 2`);
	console.debug("Applied migration 2");
}
if (version < 3) {
	db.run(`CREATE TABLE quotes (
		category TEXT NOT NULL,
		guild_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		quote TEXT NOT NULL,
		author_user_id TEXT NOT NULL,
		timestamp INTEGER NOT NULL
	) STRICT`);
	db.run(`CREATE INDEX idx_quotes_category ON quotes(category)`);
	// Ensure no category has duplicate messages
	db.run(
		`CREATE UNIQUE INDEX idx_quotes_category_channel_message ON quotes(category, guild_id, channel_id, message_id)`,
	);
	db.run(`UPDATE schema_version SET version = 3`);
	console.debug("Applied migration 3");
}
if (version < 4) {
	db.run(`CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		guild_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		author_id TEXT NOT NULL,
		timestamp INTEGER NOT NULL,
		content TEXT NOT NULL
	) STRICT`);
	db.run(`CREATE INDEX idx_messages_author ON messages (author_id)`);
	db.run(`CREATE TABLE markov4 (
		message_id TEXT NOT NULL,
		word1 TEXT,
		word2 TEXT,
		word3 TEXT,
		word4 TEXT,
		word5 TEXT,
		FOREIGN KEY (message_id) REFERENCES messages (id)
	)`);
	db.run(`CREATE INDEX idx_markov4_message_id ON markov4 (message_id)`);
	db.run(
		`CREATE INDEX idx_markov4_prefix ON markov4 (word1, word2, word3, word4)`,
	);
	db.run(`UPDATE schema_version SET version = 4`);
	console.debug("Applied migration 4");
}
console.log("Database initialization complete");

const getProblemsQuery = db.query<
	Pick<ProblemsRow, "url">,
	[ProblemsRow["date"]]
>(`SELECT url FROM problems WHERE date = ?`);
export function getProblemsForDay(offsetFromToday: number): string[] {
	const rows = getProblemsQuery.all(getDate(offsetFromToday));
	return rows.map((row) => row.url);
}

const clearProblemsQuery = db.query<null, [ProblemsRow["date"]]>(
	`DELETE FROM problems WHERE date = ?`,
);
export function clearProblemsForDay(offsetFromToday: number) {
	clearProblemsQuery.run(getDate(offsetFromToday));
}

const setProblemsQuery = db.query<
	null,
	[ProblemsRow["date"], ProblemsRow["url"]]
>(`INSERT INTO problems (date, url) VALUES (?, ?)`);
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
					);
				}
				throw error;
			}
		}
	});
	runTransaction(urls, date);
}

export class UniquenessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UniquenessError";
	}
}

const listQuery = db.query<
	Pick<ProblemsRow, "date" | "url">,
	[ProblemsRow["date"]]
>(`SELECT date, url FROM problems WHERE date >= ? ORDER BY date ASC`);
export function listProblems(includePast: boolean): Map<Date, string[]> {
	// Map using seconds since epoch as the keys, since Date objects don't equal each other
	const epochMap: Map<number, string[]> = new Map();
	const minDate = includePast ? 0 : getDate(0);
	const rows = listQuery.iterate(minDate);
	for (const row of rows) {
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

const createAnnouncementQuery = db.query<
	null,
	[AnnouncementsRow["message_id"], AnnouncementsRow["date"]]
>("INSERT INTO announcements (message_id, date) VALUES (?, ?)");
export function createAnnouncement(message: Message) {
	createAnnouncementQuery.run(message.id, getDate(0));
}

const recordSolveQuery = db.query<
	null,
	[
		SolvesRow["user_id"],
		SolvesRow["announcement_id"],
		SolvesRow["solve_time"],
	]
>("INSERT INTO solves (user_id, announcement_id, solve_time) VALUES (?, ?, ?)");
const getSolveCountQuery = db.query<
	{ count: number },
	[SolvesRow["announcement_id"]]
>(`SELECT COUNT(*) AS "count" FROM solves WHERE announcement_id = ?`);
/** @returns true if the solve being recorded is the first solve for the announcement */
export function recordSolve(
	user: User | PartialUser,
	announcement: Message | PartialMessage,
): boolean {
	const now = Math.floor(Date.now() / 1000);
	const row = db.transaction(() => {
		recordSolveQuery.run(user.id, announcement.id, now);
		return getSolveCountQuery.get(announcement.id);
	})();
	return row?.count === 1;
}

const deleteSolveQuery = db.query<
	Pick<SolvesRow, "solve_time">,
	[SolvesRow["user_id"], SolvesRow["announcement_id"]]
>(
	"DELETE FROM solves WHERE user_id = ? AND announcement_id = ? RETURNING solve_time",
);
const getFirstSolveQuery = db.query<
	Pick<SolvesRow, "user_id" | "solve_time">,
	[SolvesRow["announcement_id"]]
>(
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
	return db.transaction(() => {
		const del = deleteSolveQuery.get(user.id, announcement.id);
		const get = getFirstSolveQuery.get(announcement.id);
		return {
			changed:
				del === null
					? false
					: get === null || del.solve_time < get.solve_time,
			userId: get?.user_id ?? null,
		};
	})();
}

const lookupAnnouncementQuery = db.query<
	{ "1": 1 },
	[AnnouncementsRow["message_id"]]
>("SELECT 1 FROM announcements WHERE message_id = ?");
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
const getUserSolveCountQuery = db.query<
	{ count: number },
	[SolvesRow["user_id"]]
>(`SELECT COUNT(*) as "count" FROM solves WHERE user_id = ?`);
const getUserFirstSolveCountQuery = db.query<
	{ count: number },
	[SolvesRow["user_id"]]
>(
	// Note: this query uses SQLite-specific behavior regarding MIN() and GROUP BY.
	// See https://sqlite.org/lang_select.html#bare_columns_in_an_aggregate_query
	`WITH first_solves AS (
		SELECT user_id, MIN(solve_time) as solve_time
		FROM solves
		WHERE solve_time IS NOT NULL
		GROUP BY announcement_id
	)
	SELECT COUNT(*) as "count"
	FROM first_solves
	WHERE user_id = ?`,
);
const getUserLongestStreakQuery = db.query<
	{ length: number },
	[SolvesRow["user_id"]]
>(
	`WITH valid_solves AS (
		SELECT announcements.date
		FROM solves
		JOIN announcements ON solves.announcement_id = announcements.message_id
		WHERE
			solves.user_id = ?
			AND (
				solves.solve_time is NULL
				OR solves.solve_time - announcements.date < 86400
			)
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

export type UnsolvedAnnouncement = Pick<
	AnnouncementsRow,
	"message_id" | "date"
>;

const getUnsolvedAnnouncementsQuery = db.query<
	UnsolvedAnnouncement,
	[User["id"]]
>(
	`WITH
		user_solves AS (SELECT * FROM solves WHERE user_id = ?)
	SELECT a.message_id, a.date
	FROM announcements AS a
	LEFT OUTER JOIN user_solves AS s
	ON s.announcement_id = a.message_id
	WHERE s.announcement_id IS NULL
	ORDER BY a.date ASC`,
);
export function getUnsolvedAnnouncements(
	user: User | PartialUser,
): UnsolvedAnnouncement[] {
	return getUnsolvedAnnouncementsQuery.all(user.id);
}

const recordQuoteQuery = db.query<
	null,
	[QuoteCategories, string, string, string, string, string, number]
>(
	`INSERT INTO quotes (category, guild_id, channel_id, message_id, author_user_id, quote, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
export function recordQuote(message: Message<true>, category: QuoteCategories) {
	const now = Math.floor(Date.now() / 1000);
	try {
		recordQuoteQuery.run(
			category,
			message.guildId,
			message.channelId,
			message.id,
			message.author.id,
			message.content.trim(),
			now,
		);
	} catch (error) {
		if (
			error instanceof SQLiteError &&
			error.code === "SQLITE_CONSTRAINT_UNIQUE"
		) {
			throw new UniquenessError(
				`Message ${messageLink(message.channelId, message.id, message.guildId)} is already quoted in category ${category}`,
			);
		}
		throw error;
	}
}

const getRandomQuoteInCategoryQuery = db.query<
	QuoteRow,
	[QuoteRow["category"]]
>(`SELECT * FROM quotes WHERE category = ? ORDER BY RANDOM() LIMIT 1`);
export function getRandomQuoteInCategory(category: QuoteCategories) {
	return getRandomQuoteInCategoryQuery.get(category);
}

/**
 * Forwards to {@linkcode db.transaction()}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function doInTransaction<A extends any[], R>(fn: (...args: A) => R) {
	return db.transaction(fn);
}

const insertMessageQuery = db.query<
	null,
	[
		MessageRow["id"],
		MessageRow["channel_id"],
		MessageRow["guild_id"],
		MessageRow["author_id"],
		MessageRow["timestamp"],
		MessageRow["content"],
	]
>(
	`INSERT INTO messages (id, channel_id, guild_id, author_id, timestamp, content) VALUES (?, ?, ?, ?, ?, ?)`,
);
export function createMessage(message: Message<true>) {
	return insertMessageQuery.run(
		message.id,
		message.channelId,
		message.guildId,
		message.author.id,
		Math.floor(message.createdTimestamp / 1000),
		message.content,
	);
}

const createMarkov4EntryQuery = db.query<
	null,
	[
		Markov4Row["message_id"],
		Markov4Row["word1"],
		Markov4Row["word2"],
		Markov4Row["word3"],
		Markov4Row["word4"],
		Markov4Row["word5"],
	]
>(
	`INSERT INTO markov4 (message_id, word1, word2, word3, word4, word5) VALUES (?, ?, ?, ?, ?, ?)`,
);
export function createMarkov4Entry(
	message: Message,
	word1: string | null,
	word2: string | null,
	word3: string | null,
	word4: string | null,
	word5: string | null,
) {
	return createMarkov4EntryQuery.run(
		message.id,
		word1,
		word2,
		word3,
		word4,
		word5,
	);
}

const nextTokenCandidateCountQuery = db.query<
	{ count: number },
	[
		MessageRow["author_id"] | null,
		Markov4Row["word1"],
		Markov4Row["word2"],
		Markov4Row["word3"],
		Markov4Row["word4"],
	]
>(
	`SELECT count(*) AS "count"
	FROM markov4
	JOIN messages ON markov4.message_id = messages.id
	WHERE
		(?1 IS NULL OR messages.author_id = ?1)
		AND markov4.word1 IS ?2
		AND markov4.word2 IS ?3
		AND markov4.word3 IS ?4
		AND markov4.word4 IS ?5`,
);
const nextTokenQuery = db.query<
	Pick<Markov4Row, "word5">,
	[
		MessageRow["author_id"] | null,
		Markov4Row["word1"],
		Markov4Row["word2"],
		Markov4Row["word3"],
		Markov4Row["word4"],
		number,
	]
>(
	`SELECT markov4.word5
	FROM markov4
	JOIN messages ON markov4.message_id = messages.id
	WHERE
		(?1 IS NULL OR messages.author_id = ?1)
		AND markov4.word1 IS ?2
		AND markov4.word2 IS ?3
		AND markov4.word3 IS ?4
		AND markov4.word4 IS ?5
	LIMIT 1
	OFFSET ?6`,
);
export function getNextMarkovToken(
	authorId: MessageRow["author_id"] | undefined,
	word1: string | null,
	word2: string | null,
	word3: string | null,
	word4: string | null,
): string | null {
	const count =
		nextTokenCandidateCountQuery.get(
			authorId ?? null,
			word1,
			word2,
			word3,
			word4,
		)?.count ?? 0;
	if (count === 0) return null;
	const offset = Math.floor(Math.random() * count);
	return (
		nextTokenQuery.get(authorId ?? null, word1, word2, word3, word4, offset)
			?.word5 ?? null
	);
}
