import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { DatabaseService } from "./database";
import { exchangeBalances, members } from "../db/schema";
import type { CronService } from "./cron";
import type { EnvService } from "./env";

const USER = "100000000000000001";

describe("DatabaseService.querySync", () => {
	let db: DatabaseService;
	const balance = () =>
		db.querySync("read", (tx) =>
			tx.select().from(exchangeBalances).where(eq(exchangeBalances.user_id, USER)).get(),
		)?.balance;

	beforeEach(async () => {
		const env = { vars: { DATABASE_FILE: ":memory:" } } as unknown as EnvService;
		const cron = { createJob() {} } as unknown as CronService;
		db = await DatabaseService.new(env, cron);
		db.querySync("seed", (tx) => {
			tx.insert(members)
				.values({ user_id: USER, display_name: "u", username: "u", is_bot: false })
				.run();
			tx.insert(exchangeBalances).values({ user_id: USER, balance: 100 }).run();
		});
	});

	test("commits all writes and returns the callback's result", () => {
		const result = db.querySync("write", (tx) => {
			tx.update(exchangeBalances).set({ balance: 50 }).run();
			return "done";
		});
		expect(result).toBe("done");
		expect(balance()).toBe(50);
	});

	test("rolls back earlier writes when a later step throws", () => {
		expect(() =>
			db.querySync("partial write", (tx) => {
				tx.update(exchangeBalances).set({ balance: 0 }).run();
				throw new Error("later step failed");
			}),
		).toThrow("later step failed");
		expect(balance()).toBe(100);
	});

	test("rejects async callbacks, which would run outside the transaction", () => {
		expect(() => db.querySync("async", async () => {})).toThrow("async callback");
	});
});
