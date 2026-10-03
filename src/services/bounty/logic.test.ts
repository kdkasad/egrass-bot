import { describe, expect, test } from "bun:test";
import {
	decideCancel,
	decideClaim,
	decideCreate,
	decideExpiry,
	decideVerification,
	type BountyState,
	type ClaimState,
	type CreateRequest,
	paginate,
} from "./logic";
import { Reasons } from "./messages";
import { MockTimeSource, parseDuration } from "../../utils/time";

const POSTER = "poster";
const ALICE = "alice";
const BOB = "bob";

function makeBounty(overrides: Partial<BountyState> = {}): BountyState {
	return {
		id: 1,
		posterId: POSTER,
		task: "Solve today's problem",
		amount: 10,
		requiresVerification: false,
		expiresAt: null,
		status: "open",
		...overrides,
	};
}

function makeClaim(overrides: Partial<ClaimState> = {}): ClaimState {
	return { id: 1, bountyId: 1, claimerId: ALICE, status: "pending", ...overrides };
}

describe("creating a bounty", () => {
	const now = new Date(0);
	const base: CreateRequest = {
		task: "Do the thing",
		amount: 10,
		posterBalance: 25,
		timeLimitMs: null,
		now,
	};

	test("succeeds with enough balance and no time limit", () => {
		expect(decideCreate(base)).toEqual({ do: "create", task: "Do the thing", expiresAt: null });
	});

	test("sets the deadline relative to now", () => {
		expect(decideCreate({ ...base, timeLimitMs: parseDuration("1d") })).toEqual({
			do: "create",
			task: "Do the thing",
			expiresAt: new Date(parseDuration("1d")),
		});
	});

	test("trims the task", () => {
		expect(decideCreate({ ...base, task: "  padded  " })).toMatchObject({ task: "padded" });
	});

	test("allows a time limit of exactly 365 days", () => {
		expect(decideCreate({ ...base, timeLimitMs: parseDuration("365d") }).do).toBe("create");
	});

	test("allows spending the entire balance", () => {
		expect(decideCreate({ ...base, amount: 25 }).do).toBe("create");
	});

	const rejections: [string, Partial<CreateRequest>, string][] = [
		["insufficient balance", { amount: 26 }, Reasons.insufficientBalance(26, 25)],
		["empty task", { task: "   " }, Reasons.emptyTask],
		["task too long", { task: "x".repeat(201) }, Reasons.taskTooLong(200)],
		["zero amount", { amount: 0 }, Reasons.invalidAmount],
		["fractional amount", { amount: 1.5 }, Reasons.invalidAmount],
		[
			"time limit under a minute",
			{ timeLimitMs: parseDuration("30s") },
			Reasons.invalidTimeLimit,
		],
		["unparseable time limit (parses to 0)", { timeLimitMs: 0 }, Reasons.invalidTimeLimit],
		[
			"time limit over 365 days",
			{ timeLimitMs: parseDuration("366d") },
			Reasons.invalidTimeLimit,
		],
		[
			"time limit too large for a date",
			{ timeLimitMs: parseDuration("999999999d") },
			Reasons.invalidTimeLimit,
		],
	];
	for (const [name, overrides, reason] of rejections) {
		test(`rejects: ${name}`, () => {
			expect(decideCreate({ ...base, ...overrides })).toEqual({ do: "reject", reason });
		});
	}
});

describe("claiming a bounty", () => {
	const now = new Date(0);
	const base = { claimerId: ALICE, claimerIsBot: false, pendingClaims: [], now };

	test("pays out immediately when verification is not required", () => {
		expect(decideClaim({ ...base, bounty: makeBounty() })).toEqual({ do: "payout" });
	});

	test("asks the poster when verification is required", () => {
		expect(
			decideClaim({ ...base, bounty: makeBounty({ requiresVerification: true }) }),
		).toEqual({ do: "request-verification" });
	});

	test("lets several users have pending claims at once", () => {
		const bounty = makeBounty({ requiresVerification: true });
		const pendingClaims = [makeClaim({ claimerId: ALICE })];
		expect(decideClaim({ ...base, bounty, pendingClaims, claimerId: BOB })).toEqual({
			do: "request-verification",
		});
	});

	test("rejects a second pending claim from the same user", () => {
		const bounty = makeBounty({ requiresVerification: true });
		const pendingClaims = [makeClaim({ claimerId: ALICE })];
		expect(decideClaim({ ...base, bounty, pendingClaims })).toEqual({
			do: "reject",
			reason: Reasons.alreadyPending(1),
		});
	});

	test("rejects claiming your own bounty", () => {
		expect(decideClaim({ ...base, bounty: makeBounty(), claimerId: POSTER })).toEqual({
			do: "reject",
			reason: Reasons.ownBounty,
		});
	});

	test("rejects bots", () => {
		expect(decideClaim({ ...base, bounty: makeBounty(), claimerIsBot: true })).toEqual({
			do: "reject",
			reason: Reasons.botClaimer,
		});
	});

	for (const status of ["completed", "expired", "cancelled"] as const) {
		test(`rejects a ${status} bounty`, () => {
			expect(decideClaim({ ...base, bounty: makeBounty({ status }) })).toEqual({
				do: "reject",
				reason: Reasons.notOpen(1),
			});
		});
	}

	test("accepts an image as proof", () => {
		const proofImage = { size: 2_000_000, contentType: "image/png" };
		expect(decideClaim({ ...base, bounty: makeBounty(), proofImage })).toEqual({
			do: "payout",
		});
	});

	const badImages: [string, { size: number; contentType: string | null }, string][] = [
		["a non-image file", { size: 100, contentType: "application/pdf" }, Reasons.proofNotImage],
		["an unknown content type", { size: 100, contentType: null }, Reasons.proofNotImage],
		[
			"an image over 10 MB",
			{ size: 10 * 1024 * 1024 + 1, contentType: "image/jpeg" },
			Reasons.proofTooLarge,
		],
	];
	for (const [name, proofImage, reason] of badImages) {
		test(`rejects ${name} as proof`, () => {
			expect(decideClaim({ ...base, bounty: makeBounty(), proofImage })).toEqual({
				do: "reject",
				reason,
			});
		});
	}

	test("deadline: allowed just before, rejected at and after", () => {
		const time = new MockTimeSource();
		const bounty = makeBounty({ expiresAt: new Date(parseDuration("1h")) });

		time.advance({ minutes: 59, seconds: 59 });
		expect(decideClaim({ ...base, bounty, now: time.now() }).do).toBe("payout");

		time.advance({ seconds: 1 });
		expect(decideClaim({ ...base, bounty, now: time.now() })).toEqual({
			do: "reject",
			reason: Reasons.deadlinePassed(1),
		});
	});
});

describe("verifying a claim", () => {
	const bounty = makeBounty({ requiresVerification: true });

	test("poster approves: payout and void the other pending claims", () => {
		const claim = makeClaim({ id: 1, claimerId: ALICE });
		const other = makeClaim({ id: 2, claimerId: BOB });
		expect(
			decideVerification({
				bounty,
				claim,
				pendingClaims: [claim, other],
				actorId: POSTER,
				approve: true,
			}),
		).toEqual({ do: "payout", voidClaimIds: [2] });
	});

	test("poster rejects: only the claim is rejected", () => {
		const claim = makeClaim();
		expect(
			decideVerification({
				bounty,
				claim,
				pendingClaims: [claim],
				actorId: POSTER,
				approve: false,
			}),
		).toEqual({ do: "reject-claim" });
	});

	test("approval still works after the deadline (claim was made in time)", () => {
		const late = makeBounty({ requiresVerification: true, expiresAt: new Date(0) });
		const claim = makeClaim();
		expect(
			decideVerification({
				bounty: late,
				claim,
				pendingClaims: [claim],
				actorId: POSTER,
				approve: true,
			}),
		).toEqual({ do: "payout", voidClaimIds: [] });
	});

	test("only the poster can decide", () => {
		const claim = makeClaim();
		for (const approve of [true, false]) {
			expect(
				decideVerification({
					bounty,
					claim,
					pendingClaims: [claim],
					actorId: BOB,
					approve,
				}),
			).toEqual({
				do: "reject",
				reason: Reasons.notPosterVerify,
			});
		}
	});

	test("an already-approved claim cannot be decided again", () => {
		const claim = makeClaim({ status: "approved" });
		const completed = makeBounty({ requiresVerification: true, status: "completed" });
		expect(
			decideVerification({
				bounty: completed,
				claim,
				pendingClaims: [],
				actorId: POSTER,
				approve: true,
			}),
		).toEqual({ do: "reject", reason: Reasons.claimResolved });
	});
});

describe("cancelling a bounty", () => {
	const ADMIN = "admin";
	const base = { bounty: makeBounty(), pendingClaims: [], actorId: POSTER, actorIsAdmin: false };

	test("poster can cancel an open bounty with no pending claims", () => {
		expect(decideCancel(base)).toEqual({ do: "cancel", voidClaimIds: [] });
	});

	test("poster cannot cancel while a claim awaits approval", () => {
		expect(decideCancel({ ...base, pendingClaims: [makeClaim()] })).toEqual({
			do: "reject",
			reason: Reasons.pendingClaimsBlockCancel(1),
		});
	});

	test("other users cannot cancel", () => {
		expect(decideCancel({ ...base, actorId: ALICE })).toEqual({
			do: "reject",
			reason: Reasons.notPosterCancel,
		});
	});

	test("an admin can cancel someone else's bounty", () => {
		expect(decideCancel({ ...base, actorId: ADMIN, actorIsAdmin: true })).toEqual({
			do: "cancel",
			voidClaimIds: [],
		});
	});

	test("an admin can cancel with claims awaiting approval, voiding them", () => {
		const pendingClaims = [makeClaim({ id: 3 }), makeClaim({ id: 4, claimerId: BOB })];
		expect(
			decideCancel({ ...base, pendingClaims, actorId: ADMIN, actorIsAdmin: true }),
		).toEqual({ do: "cancel", voidClaimIds: [3, 4] });
	});

	test("nobody can cancel a closed bounty, not even an admin", () => {
		for (const status of ["completed", "expired", "cancelled"] as const) {
			const bounty = makeBounty({ status });
			expect(decideCancel({ ...base, bounty })).toEqual({
				do: "reject",
				reason: Reasons.notOpen(1),
			});
			expect(decideCancel({ ...base, bounty, actorId: ADMIN, actorIsAdmin: true })).toEqual({
				do: "reject",
				reason: Reasons.notOpen(1),
			});
		}
	});
});

describe("expiring bounties", () => {
	test("full lifecycle: waits for pending claim, expires once it is rejected", () => {
		const time = new MockTimeSource();
		const bounty = makeBounty({
			requiresVerification: true,
			expiresAt: new Date(parseDuration("1h")),
		});
		const claim = makeClaim();

		// Before the deadline: nothing
		time.advance({ minutes: 30 });
		expect(decideExpiry({ bounty, pendingClaims: [claim], now: time.now() })).toEqual({
			do: "nothing",
		});

		// After the deadline, but a claim is pending: wait for the poster
		time.advance({ hours: 1 });
		expect(decideExpiry({ bounty, pendingClaims: [claim], now: time.now() })).toEqual({
			do: "nothing",
		});

		// Poster rejects the claim, so the next sweep expires the bounty
		expect(
			decideVerification({
				bounty,
				claim,
				pendingClaims: [claim],
				actorId: POSTER,
				approve: false,
			}),
		).toEqual({ do: "reject-claim" });
		expect(decideExpiry({ bounty, pendingClaims: [], now: time.now() })).toEqual({
			do: "expire",
		});
	});

	test("bounties without a time limit never expire", () => {
		expect(
			decideExpiry({
				bounty: makeBounty({ expiresAt: null }),
				pendingClaims: [],
				now: new Date(8.64e15),
			}),
		).toEqual({ do: "nothing" });
	});

	test("closed bounties are not expired again", () => {
		for (const status of ["completed", "expired", "cancelled"] as const) {
			expect(
				decideExpiry({
					bounty: makeBounty({ status, expiresAt: new Date(0) }),
					pendingClaims: [],
					now: new Date(1),
				}),
			).toEqual({ do: "nothing" });
		}
	});
});

describe("pagination", () => {
	test("splits a list into pages of 10", () => {
		expect(paginate(25, 0)).toEqual({ page: 0, pageCount: 3, offset: 0 });
		expect(paginate(25, 1)).toEqual({ page: 1, pageCount: 3, offset: 10 });
		expect(paginate(25, 2)).toEqual({ page: 2, pageCount: 3, offset: 20 });
	});

	test("an exact multiple does not create an empty last page", () => {
		expect(paginate(20, 5).pageCount).toBe(2);
	});

	test("an empty list has one (empty) page", () => {
		expect(paginate(0, 0)).toEqual({ page: 0, pageCount: 1, offset: 0 });
	});

	test("clamps pages that are out of range (e.g. the list shrank)", () => {
		expect(paginate(25, 7)).toEqual({ page: 2, pageCount: 3, offset: 20 });
		expect(paginate(25, -1)).toEqual({ page: 0, pageCount: 3, offset: 0 });
		expect(paginate(25, NaN)).toEqual({ page: 0, pageCount: 3, offset: 0 });
	});
});
