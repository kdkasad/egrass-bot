import { test, expect, describe } from "bun:test";
import { withAuth, type Handler } from "./middleware";

const newRequest = (auth?: string) =>
	new Request("http://egrass-bot/api/test", {
		headers: auth ? { Authorization: auth } : undefined,
	});

const next: Handler<Request> = () => new Response();

describe("test withAuth", () => {
	const mid = withAuth("abc", next);
	const expectInvalidToken = async (res: Response) =>
		expect(await res.json()).toEqual({ reason: "Invalid API token" });

	test("valid token", async () => {
		const req = newRequest("Bearer nl4ZpkaFkR0=.6sb8m+DcBNWV0uCmv+Fd8vjEKt2QjFRAeSr6BiLDkSc=");
		const res = await mid(req);
		expect(res.status).toBe(200);
	});

	test("invalid token", async () => {
		const req = newRequest("Bearer nl4ZpkaFkR0=.6sb8n+DcBNWV0uCmv+Fd8vjEKt2QjFRAeSr6BiLDkSc=");
		const res = await mid(req);
		expect(res.status).toBe(401);
		expectInvalidToken(res);
	});

	test("missing header", async () => {
		const res = await mid(newRequest());
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ reason: "Authorization required" });
	});

	test("invalid header format", async () => {
		const req = newRequest("nl4ZpkaFkR0=.6sb8m+DcBNWV0uCmv+Fd8vjEKt2QjFRAeSr6BiLDkSc=");
		const res = await mid(req);
		expect(res.status).toBe(401);
		expectInvalidToken(res);
	});

	test("invalid token format", async () => {
		const req = newRequest("Bearer .6sb8m+DcBNWV0uCmv+Fd8vjEKt2QjFRAeSr6BiLDkSc=");
		const res = await mid(req);
		expect(res.status).toBe(401);
		expectInvalidToken(res);
	});
});
