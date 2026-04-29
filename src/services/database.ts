import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as Sentry from "@sentry/bun";
import { Service } from "../utils/service";
import * as schema from "../db/schema";

export type AppDB = BunSQLiteDatabase<typeof schema>;

export class DatabaseService extends Service {
	private readonly db: AppDB;
	private readonly rwConn: Database;
	readonly rodb: Database;

	private constructor(db: AppDB, rodb: Database, rwConn: Database) {
		super();
		this.db = db;
		this.rodb = rodb;
		this.rwConn = rwConn;
		Sentry.logger.info(`${this._name} created`);
	}

	static async new(): Promise<DatabaseService> {
		return Sentry.startSpan({ name: "DatabaseService.new", op: "function" }, async () => {
			const rwConn = new Database("data.sqlite3", {
				strict: true,
				create: true,
			});
			const roConn = new Database("data.sqlite3", {
				readonly: true,
				readwrite: false,
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
			return new DatabaseService(db, roConn, rwConn);
		});
	}

	query<T>(name: string, fn: (db: AppDB) => T): T {
		return Sentry.startSpanManual({ name, op: "db.query" }, (span) => {
			try {
				return fn(this.db);
			} finally {
				span.end();
			}
		});
	}

	async stop(): Promise<void> {
		return Sentry.startSpan({ name: "DatabaseService.stop", op: "function" }, async () => {
			this.rwConn.close();
			this.rodb.close();
			Sentry.logger.info("Database connections closed");
		});
	}
}
