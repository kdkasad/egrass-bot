/**
 * Parse a duration string
 * @param duration string representing a duration
 * @returns the duration in milliseconds
 */
export function parseDuration(duration: string): number {
	let days = duration.match(/(\d+(?:\.\d+)?)\s*d/);
	let hours = duration.match(/(\d+(?:\.\d+)?)\s*h/);
	let minutes = duration.match(/(\d+(?:\.\d+)?)\s*m($|[^s])/);
	let seconds = duration.match(/(\d+(?:\.\d+)?)\s*s/);
	let milliseconds = duration.match(/(\d+(?:\.\d+)?)\s*ms/);
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
