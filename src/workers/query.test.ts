import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { QueryResultFormat, type QueryWorkerResult } from "../types/query";

// The query worker must only ever see the main database. In particular, the
// anonymous poll database lives next to it and must not be readable.
describe("query worker isolation", () => {
	let dir: string;
	let mainDb: string;
	let otherDb: string;

	beforeAll(() => {
		dir = mkdtempSync(`${tmpdir()}/query-worker-`);
		mainDb = `${dir}/main.sqlite3`;
		otherDb = `${dir}/other.sqlite3`;
		new Database(mainDb, { create: true }).run("CREATE TABLE t (x INTEGER)");
		const other = new Database(otherDb, { create: true });
		other.run("CREATE TABLE secret (x TEXT)");
		other.run("INSERT INTO secret VALUES ('leaked')");
		other.close();
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function run(sql: string): Promise<QueryWorkerResult> {
		return new Promise((resolve) => {
			const worker = new Worker(new URL("./query.ts", import.meta.url));
			worker.onmessage = (e) => {
				resolve(e.data);
				worker.terminate();
			};
			worker.postMessage({ sql, format: QueryResultFormat.JSON, dbFile: mainDb });
		});
	}

	for (const sql of [
		"ATTACH DATABASE '{other}' AS o",
		"  attach '{other}' AS o",
		"-- comment\n/* block */ ATTACH '{other}' AS o",
	]) {
		test(`rejects ${JSON.stringify(sql)}`, async () => {
			const result = await run(sql.replace("{other}", otherDb));
			expect(result.status).toBe("error");
		});
	}

	test("cannot read another database file in a single statement", async () => {
		for (const sql of [
			`SELECT * FROM o.secret`,
			`SELECT readfile('${otherDb}')`,
			`SELECT load_extension('${otherDb}')`,
		]) {
			const result = await run(sql);
			expect(result.status).toBe("error");
		}
	});

	test("only the main database is open", async () => {
		const result = await run("SELECT name FROM pragma_database_list");
		expect(result).toEqual({
			status: "success",
			formattedResult: JSON.stringify([{ name: "main" }]),
		});
	});
});
