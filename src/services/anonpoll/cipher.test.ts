import { test, expect } from "bun:test";
import { PollCipher } from "./cipher";

test("data can't be read with another key", () => {
	const secret = new PollCipher("secret");
	const other = new PollCipher("other");
	const blob = secret.encryptTally([1, 2]);
	expect(secret.decryptTally(blob)).toEqual([1, 2]);
	expect(() => other.decryptTally(blob)).toThrow();
});
