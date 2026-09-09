import { describe, expect, test } from "bun:test";
import { MockTimeSource, parseDuration } from "./time";

describe("duration parsing", () => {
	const cases: [string, number][] = [
		["1d 1h 1m 1s 1ms", 90061001],
		["1h", 3600000],
		["1m 16s", 76000],
		["16.7 s", 16700],
	];
	for (const [str, expected] of cases) {
		test(str, () => {
			expect(parseDuration(str)).toBe(expected);
		});
	}
});

describe("advance MockTimeSource", () => {
	const ts = new MockTimeSource();
	const before = ts.now();
	ts.advance({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: 5 });
	const after = ts.now();
	expect({ before, after }).toMatchInlineSnapshot(`
	  {
	    "after": 1970-01-02T02:03:04.005Z,
	    "before": 1970-01-01T00:00:00.000Z,
	  }
	`);
	expect(before).toMatchInlineSnapshot(`1970-01-01T00:00:00.000Z`);
	expect(after).toMatchInlineSnapshot(`1970-01-02T02:03:04.005Z`);
});
