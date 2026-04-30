/**
 * Parse a duration string
 * @param duration string representing a duration
 * @returns the duration in milliseconds
 */
export function parseDuration(duration: string): number {
	const days = duration.match(/(\d+(?:\.\d+)?)\s*d/);
	const hours = duration.match(/(\d+(?:\.\d+)?)\s*h/);
	const minutes = duration.match(/(\d+(?:\.\d+)?)\s*m($|[^s])/);
	const seconds = duration.match(/(\d+(?:\.\d+)?)\s*s/);
	const milliseconds = duration.match(/(\d+(?:\.\d+)?)\s*ms/);
	const matchToNum = (match: RegExpMatchArray | null) =>
		match === null ? 0 : parseFloat(match[1]);
	return Math.round(
		matchToNum(milliseconds) +
			matchToNum(seconds) * 1000 +
			matchToNum(minutes) * 1000 * 60 +
			matchToNum(hours) * 1000 * 60 * 60 +
			matchToNum(days) * 1000 * 60 * 60 * 24,
	);
}

/**
 * Converts a {@link Date} to a SQLite timestamp
 * @param date a date
 * @returns seconds since epoch
 */
export function dateToSqlite(date: Date): number {
	return Math.floor(date.getTime() / 1000);
}

/**
 * Converts a SQLite timestamp to a {@link Date}
 * @param timestamp seconds since epoch
 * @returns a date
 */
export function sqliteToDate(timestamp: number): Date {
	return new Date(timestamp * 1000);
}
