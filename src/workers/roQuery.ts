// Worker to execute an arbitrary read-only query against the database.

import { rodb } from "../db";
import type { QueryWorkerResult } from "../utils";

declare const self: Worker;

// Wait for initial message with list of bot user IDs
self.addEventListener(
	"message",
	(event) => {
		const sql = event.data as string;
		try {
			const query = rodb.prepare<Record<string, unknown>, []>(sql);
			const results = query.all();
			self.postMessage({
				status: "success",
				results,
			} satisfies QueryWorkerResult);
		} catch (thrown) {
			const error =
				thrown instanceof Error ? thrown : new Error(String(thrown));
			self.postMessage({
				status: "error",
				error,
				originalErrorName: error.name,
			} satisfies QueryWorkerResult);
		}
	},
	{ once: true },
);
