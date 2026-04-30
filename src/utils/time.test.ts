import { describe, expect, test } from "bun:test";
import { parseDuration } from "./time";

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
