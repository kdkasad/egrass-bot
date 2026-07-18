import { z } from "zod";
import { Result } from "../../utils/result";

export enum Difficulty {
	Easy,
	Medium,
	Hard,
}

export interface LeetCodeProblem {
	slug: string;
	title: string;
	difficulty: Difficulty;
}

export const ProblemURL = z.codec(
	z.url({
		normalize: true,
		protocol: /^https?$/,
		hostname: /^leetcode\.com$/,
	}),
	z.string(),
	{
		decode(s, ctx) {
			const url = new URL(s);
			const match = url.pathname.match(/^\/problems\/([^/]+)(?:\/|$)/);
			if (!match) {
				ctx.issues.push({
					code: "custom",
					message: "URL path does not match /problems/<slug>/",
					input: url,
				});
				return z.NEVER;
			}
			return match[1];
		},
		encode(problemId) {
			return `https://leetcode.com/problems/${problemId}/`;
		},
	},
);

async function makeGraphQLQuery<T>(
	query: string,
	variables: Record<string, unknown>,
	responseSchema: z.ZodType<T>,
): Promise<T> {
	const request = new Request("https://leetcode.com/graphql/", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	console.log(request);
	const response = await fetch(request);
	if (!response.ok) {
		throw new Error(`LeetCode API returned ${response.status} ${response.statusText}`);
	}
	const json = await response.json();
	const result = z
		.object({
			data: responseSchema,
			errors: z.array(z.unknown()).optional(),
		})
		.parse(json);
	if (result.errors && result.errors.length > 0) {
		throw new Error(`LeetCode API returned errors: ${JSON.stringify(result.errors)}`);
	}
	return result.data;
}

export async function fetchProblem(id: string): Promise<Result<LeetCodeProblem, Error>> {
	const query = `
		query GetQuestion($titleSlug: String!) {
		  question(titleSlug: $titleSlug) {
		    questionId
		    questionFrontendId
		    title
		    titleSlug
		    isPaidOnly
		    difficulty
		    likes
		    dislikes
		  }
		}`;
	const responseSchema = z.object({
		question: z
			.object({
				title: z.string(),
				titleSlug: z.string(),
				difficulty: z.enum(["Easy", "Medium", "Hard"]),
			})
			.transform(
				(q) =>
					({
						title: q.title,
						slug: q.titleSlug,
						difficulty:
							q.difficulty === "Easy"
								? Difficulty.Easy
								: q.difficulty === "Medium"
									? Difficulty.Medium
									: Difficulty.Hard,
					}) satisfies LeetCodeProblem,
			)
			.nullable(),
	});

	const response = await makeGraphQLQuery(query, { titleSlug: id }, responseSchema);
	if (response.question === null) {
		return Result.error(new Error(`Problem "${id}" not found`));
	}
	return Result.ok(response.question);
}

export function formatProblemTitle(problem: LeetCodeProblem): string {
	const difficultyEmoji = {
		[Difficulty.Easy]: "🟢",
		[Difficulty.Medium]: "🟡",
		[Difficulty.Hard]: "🔴",
	}[problem.difficulty];
	return `${difficultyEmoji} ${problem.title}`;
}
