import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** What an encrypted blob holds; bound into it so blobs can't be swapped */
type BlobKind = "info" | "tally";

/**
 * Encrypts anonymous poll data with AES-256-GCM, and hashes voter IDs with
 * HMAC-SHA256, using keys derived from one secret.
 */
export class PollCipher {
	readonly #encKey: Buffer;
	readonly #macKey: Buffer;

	constructor(secret: string) {
		const derive = (info: string) =>
			Buffer.from(hkdfSync("sha256", secret, "", `egrass-bot anonpoll ${info}`, 32));
		this.#encKey = derive("encryption");
		this.#macKey = derive("voter");
	}

	encrypt(pollId: string, kind: BlobKind, plain: Uint8Array): Buffer {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv("aes-256-gcm", this.#encKey, iv);
		cipher.setAAD(Buffer.from(`${kind}:${pollId}`));
		const body = Buffer.concat([cipher.update(plain), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), body]);
	}

	decrypt(pollId: string, kind: BlobKind, blob: Uint8Array): Buffer {
		const buf = Buffer.from(blob);
		const decipher = createDecipheriv("aes-256-gcm", this.#encKey, buf.subarray(0, IV_LENGTH));
		decipher.setAAD(Buffer.from(`${kind}:${pollId}`));
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
	encryptTally(pollId: string, counts: number[]): Buffer {
		const plain = Buffer.alloc(counts.length * 4);
		counts.forEach((c, i) => plain.writeUInt32BE(c, i * 4));
		return this.encrypt(pollId, "tally", plain);
	}

	decryptTally(pollId: string, blob: Uint8Array): number[] {
		const plain = this.decrypt(pollId, "tally", blob);
		const counts: number[] = [];
		for (let i = 0; i < plain.length; i += 4) counts.push(plain.readUInt32BE(i));
		return counts;
	}

	/** Stands in for a user ID in one poll; differs between polls for the same user */
	voterId(pollId: string, userId: string): string {
		return createHmac("sha256", this.#macKey).update(`${pollId}:${userId}`).digest("hex");
	}
}
