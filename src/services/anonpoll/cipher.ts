import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Encrypts anonymous poll data with AES-256-GCM, and hashes voter IDs with
 * HMAC-SHA256, using keys derived from one secret.
 */
export class PollCipher {
	readonly #encKey: Buffer;
	readonly #macKey: Buffer;

	constructor(secret: string) {
		this.#encKey = Buffer.from(
			hkdfSync("sha256", secret, "", `egrass-bot anonpoll encryption`, 32),
		);
		this.#macKey = Buffer.from(hkdfSync("sha256", secret, "", `egrass-bot anonpoll voter`, 32));
	}

	encrypt(plain: Buffer): Buffer {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv("aes-256-gcm", this.#encKey, iv, {
			authTagLength: TAG_LENGTH,
		});
		const body = Buffer.concat([cipher.update(plain), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), body]);
	}

	decrypt(blob: Buffer): Buffer {
		const buf = Buffer.from(blob);
		const decipher = createDecipheriv("aes-256-gcm", this.#encKey, buf.subarray(0, IV_LENGTH), {
			authTagLength: TAG_LENGTH,
		});
		decipher.setAuthTag(buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
		return Buffer.concat([
			decipher.update(buf.subarray(IV_LENGTH + TAG_LENGTH)),
			decipher.final(),
		]);
	}

	/**
	 * Counts are fixed-width so the blob's length never depends on them, which
	 * would otherwise reveal a vote whenever a count gained a digit.
	 */
	encryptTally(counts: number[]): Buffer {
		const plain = Buffer.alloc(counts.length * 4);
		counts.forEach((c, i) => plain.writeUInt32BE(c, i * 4));
		return this.encrypt(plain);
	}

	decryptTally(blob: Buffer): number[] {
		const plain = this.decrypt(blob);
		const counts: number[] = [];
		for (let i = 0; i < plain.length; i += 4) counts.push(plain.readUInt32BE(i));
		return counts;
	}

	/** Separate from voter hashes so the author's voting status is not exposed. */
	authorId(pollId: string, userId: string): string {
		return createHmac("sha256", this.#macKey)
			.update(`author:${pollId}:${userId}`)
			.digest("hex");
	}

	/** Stands in for a user ID in one poll; differs between polls for the same user */
	voterId(pollId: string, userId: string): string {
		return createHmac("sha256", this.#macKey).update(`${pollId}:${userId}`).digest("hex");
	}
}
