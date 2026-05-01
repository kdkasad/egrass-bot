import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as Sentry from "@sentry/bun";

import { Service } from "../utils/service";
import { traced } from "../utils/tracing";
import * as schema from "../db/schema";
import type { EnvService } from "./env";
import { parseDuration } from "../utils/time";
import type { CronService } from "./cron";

export type AppDB = BunSQLiteDatabase<typeof schema>;

const DB_BUSY_TIMEOUT_MS = parseDuration("5s");

export class DatabaseService extends Service {
	private readonly db: AppDB;
	private readonly rwConn: Database;
	readonly dbFilename: string;

	private constructor(db: AppDB, rwConn: Database) {
		super();
		this.db = db;
		this.rwConn = rwConn;
		this.dbFilename = rwConn.filename;
		Sentry.logger.info(`${this._name} created`);
	}

	@traced()
	static async new(env: EnvService, cron: CronService): Promise<DatabaseService> {
		const rwConn = new Database(env.vars.DATABASE_FILE, {
			strict: true,
			create: true,
		});
		rwConn.run("PRAGMA journal_mode = WAL");
		rwConn.run(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
		rwConn.run("PRAGMA foreign_keys = ON");

		// Recommended by <https://sqlite.org/lang_analyze.html>.
		rwConn.run("PRAGMA optimize=0x10002");
		cron.createJob("analyze database", "0 4 * * *", async () => {
			rwConn.run("PRAGMA optimize");
		});

		const db = drizzle(rwConn, {
			schema,
			logger: {
				logQuery(sql, params) {
					Sentry.logger.debug("SQL query", { sql, params });
				},
			},
		});
		migrate(db, {
			migrationsFolder: Bun.fileURLToPath(new URL("../../drizzle", import.meta.url)),
		});
		Sentry.logger.info("Database initialization complete");
		return new DatabaseService(db, rwConn);
	}

	async query<T>(
		name: string,
		fn: (...args: Parameters<Parameters<typeof this.db.transaction>[0]>) => Promise<T>,
	): Promise<T> {
		return Sentry.startSpan({ name, op: "db.query" }, async () => {
			return this.db.transaction(fn);
		});
	}

	@traced()
	async stop(): Promise<void> {
		this.rwConn.run("PRAGMA optimize");
		this.rwConn.close();
		Sentry.logger.info("Database connections closed");
	}
}

export type Transaction = Parameters<Parameters<AppDB["transaction"]>[0]>[0];
