import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as Sentry from "@sentry/bun";
import { Service } from "../utils/service";
import { traced } from "../utils/tracing";
import * as schema from "../db/schema";
import type { EnvService } from "./env";

export type AppDB = BunSQLiteDatabase<typeof schema>;

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

	static async new(env: EnvService): Promise<DatabaseService> {
		return Sentry.startSpan({ name: "DatabaseService.new", op: "function" }, async () => {
			const rwConn = new Database(env.vars.DATABASE_FILE, {
				strict: true,
				create: true,
			});
			rwConn.run("PRAGMA foreign_keys = ON");
			const db = drizzle(rwConn, {
				schema,
				logger: {
					logQuery(sql, params) {
						Sentry.logger.debug("SQL query", { sql, params });
					},
				},
			});
			migrate(db, { migrationsFolder: "drizzle" });
			Sentry.logger.info("Database initialization complete");
			return new DatabaseService(db, rwConn);
		});
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
		this.rwConn.close();
		Sentry.logger.info("Database connections closed");
	}
}

export type Transaction = Parameters<Parameters<AppDB["transaction"]>[0]>[0];
