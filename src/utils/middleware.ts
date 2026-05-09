import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/bun";

export type Handler<R extends Request> = (req: R) => Response | Promise<Response>;

/**
 * API key authentication middleware.
 *
 * Checks requests for an Authorization header containing an API key in the form
 * "<nonce>.<signature>" where signature is the HMAC of the nonce, both in base64.
 * The HMAC is computed using the given secret.
 * If the header is present and valid, the request is passed along.
 * Otherwise, a 401 response is returned.
 *
 * @param secret secret key for HMAC
 * @param next downstream request handler
 */
export function withAuth<R extends Request>(secret: string, next: Handler<R>): Handler<R> {
	return (req) => {
		const missingAuth = Response.json({ reason: "Authorization required" }, { status: 401 });
		const invalidToken = Response.json({ reason: "Invalid API token" }, { status: 401 });

		// Get Authorization header
		const auth = req.headers.get("Authorization");
		if (auth === null) return missingAuth;

		// Extract token
		const parts = auth.split(" ");
		if (parts.length !== 2) {
			return invalidToken;
		}
		const [bearer, token] = parts;
		if (bearer !== "Bearer") return invalidToken;

		// Extract nonce and signature
		const tokenParts = token.split(".");
		if (tokenParts.length !== 2) return invalidToken;
		const [nonce, hmac] = tokenParts.map((s) => Buffer.from(s, "base64"));
		if (nonce.length === 0 || hmac.length === 0) return invalidToken;

		// Check signature
		const expected = new Bun.CryptoHasher("sha256", secret).update(nonce).digest();
		if (hmac.length !== expected.length) return invalidToken;
		if (!timingSafeEqual(hmac, expected)) return invalidToken;

		Sentry.logger.info("Request authorized");
		return next(req);
	};
}

/**
 * Generates an API key compatible with the {@link withAuth} middleware.
 *
 * @param secret HMAC secret key
 * @param nonceBytes number of random bytes to use for the nonce
 */
export function generateAPIKey(secret: string, nonceBytes: number = 8): string {
	const nonce = randomBytes(nonceBytes);
	const hmac = new Bun.CryptoHasher("sha256", secret).update(nonce).digest("base64");
	return `${nonce.toString("base64")}.${hmac}`;
}

export function withAssertContentType<R extends Request>(
	expectedContentType: string | string[],
	next: Handler<R>,
): Handler<R> {
	const set = new Set(
		typeof expectedContentType === "string" ? [expectedContentType] : expectedContentType,
	);
	return (req) => {
		const contentType = req.headers.get("Content-Type")?.split(";")[0];
		if (contentType === undefined || !set.has(contentType)) {
			return Response.json(
				{
					reason: "Invalid Content-Type",
					expected: expectedContentType,
					got: contentType,
				},
				{ status: 400 },
			);
		}
		return next(req);
	};
}
