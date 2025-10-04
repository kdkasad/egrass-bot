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
		/^(https?:\/\/)?neetcode.io\/problems\/([-a-z]+)\/?(\?list=.*)$/,
		"$2",
	);
}
