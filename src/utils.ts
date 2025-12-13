// Returns a string containing a Discord-style markdown list of the problems
export function formatProblemUrls(problemUrls: string[]): string {
	let formattedUrls = "";
	for (let i = 0; i < problemUrls.length; i++) {
		if (i > 0) formattedUrls += "\n";
		formattedUrls += `- <${problemUrls[i]}>`;
	}
	return formattedUrls;
}

// Extracts the problem ID from the URL
export function extractProblemId(url: string): string {
	return url.replace(
		/^(https?:\/\/)?(neetcode\.io|leetcode.com)\/problems\/(?<id>[^/?]+)\/?(\?list=.*)?$/,
		"$<id>",
	);
}

// Returns time 00:00 on the date given by today plus the offset in days.
// E.g. getDate(1) is 00:00 tomorrow, and getDate(-1) is yesterday.
export function getDate(daysFromToday: number) {
	const DAY_IN_MS = 24 * 60 * 60 * 1000;
	const date = new Date(Date.now() + daysFromToday * DAY_IN_MS);
	date.setHours(0, 0, 0, 0);
	return date.getTime() / 1000; // won't be fractional because we set ms to 0
}

export function wrapError<R>(message: string, fn: () => R): R {
	try {
		return fn();
	} catch (error) {
		throw new Error(message, { cause: error });
	}
}

export type QueryWorkerResult =
	| {
			status: "error";
			error: Error;
			originalErrorName: string;
	  }
	| {
			status: "success";
			table: string | null;
	  };
