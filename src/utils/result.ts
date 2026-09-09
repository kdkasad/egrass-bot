export type Result<T, E> = { k: "ok"; v: T } | { k: "error"; v: E };

export const Result = {
	ok: <T>(v: T): { k: "ok"; v: T } => ({ k: "ok", v }),
	error: <E>(v: E): { k: "error"; v: E } => ({ k: "error", v }),

	isOk: <T, E>(result: Result<T, E>): result is { k: "ok"; v: T } => result.k === "ok",
	isError: <T, E>(result: Result<T, E>): result is { k: "error"; v: E } => result.k === "error",

	unwrap: <T, E>(result: Result<T, E>): T => {
		if (result.k === "ok") return result.v;
		throw new Error(
			"Unwrapped error result: " +
				(result.v instanceof Error ? result.v.message : String(result.v)),
		);
	},

	match: <T, E, R>(
		result: Result<T, E>,
		branches: {
			ok: (v: T) => R;
			error: (v: E) => R;
		},
	) => {
		if (result.k === "ok") return branches.ok(result.v);
		else return branches.error(result.v);
	},

	lift: <T, E>(results: Result<T, E>[]): Result<T[], E> => {
		const data: T[] = [];
		for (const result of results) {
			if (result.k === "error") return result;
			else data.push(result.v);
		}
		return { k: "ok", v: data };
	},

	collect: <T, E>(results: Result<T, E>[]): Result<T[], E[]> => {
		const oks: T[] = [];
		const errors: E[] = [];
		for (const result of results) {
			if (result.k === "ok") oks.push(result.v);
			else errors.push(result.v);
		}
		if (errors.length > 0) return { k: "error", v: errors };
		else return { k: "ok", v: oks };
	},
};
