/**
 * Bounty decision logic. Every function here takes the current state as plain
 * data and returns the action to take, without touching Discord or the
 * database, so that the rules can be unit tested in isolation. BountyService
 * is responsible for loading the state, calling these functions, and applying
 * the resulting actions.
 */

import { Reasons } from "./messages";
import { parseDuration } from "../../utils/time";

export type BountyStatus = "open" | "completed" | "expired" | "cancelled";
export type ClaimStatus = "pending" | "approved" | "rejected" | "voided";

export interface BountyState {
	id: number;
	posterId: string;
	task: string;
	amount: number;
	requiresVerification: boolean;
	expiresAt: Date | null;
	status: BountyStatus;
}

export interface ClaimState {
	id: number;
	bountyId: number;
	claimerId: string;
	status: ClaimStatus;
}

export type Rejection = { do: "reject"; reason: string };

export const MAX_TASK_LENGTH = 200;
export const MIN_TIME_LIMIT_MS = parseDuration("1m");
export const MAX_TIME_LIMIT_MS = parseDuration("365d");
/** Bots can only upload files up to 10 MiB, and the bot re-uploads proof images */
export const MAX_PROOF_IMAGE_BYTES = 10 * 1024 * 1024;

function isPastDeadline(bounty: BountyState, now: Date): boolean {
	return bounty.expiresAt !== null && now.getTime() >= bounty.expiresAt.getTime();
}

export interface CreateRequest {
	task: string;
	amount: number;
	posterBalance: number;
	/** Requested time limit in ms, or null for no time limit */
	timeLimitMs: number | null;
	now: Date;
}

export type CreateAction = Rejection | { do: "create"; task: string; expiresAt: Date | null };

export function decideCreate(req: CreateRequest): CreateAction {
	const task = req.task.trim();
	if (task.length === 0) {
		return { do: "reject", reason: Reasons.emptyTask };
	}
	if (task.length > MAX_TASK_LENGTH) {
		return {
			do: "reject",
			reason: Reasons.taskTooLong(MAX_TASK_LENGTH),
		};
	}
	if (!Number.isInteger(req.amount) || req.amount <= 0) {
		return { do: "reject", reason: Reasons.invalidAmount };
	}
	if (
		req.timeLimitMs !== null &&
		!(req.timeLimitMs >= MIN_TIME_LIMIT_MS && req.timeLimitMs <= MAX_TIME_LIMIT_MS)
	) {
		return {
			do: "reject",
			reason: Reasons.invalidTimeLimit,
		};
	}
	if (req.posterBalance < req.amount) {
		return {
			do: "reject",
			reason: Reasons.insufficientBalance(req.amount, req.posterBalance),
		};
	}
	return {
		do: "create",
		task,
		expiresAt: req.timeLimitMs === null ? null : new Date(req.now.getTime() + req.timeLimitMs),
	};
}

export interface ProofImage {
	size: number;
	contentType: string | null;
}

export interface ClaimRequest {
	bounty: BountyState;
	claimerId: string;
	claimerIsBot: boolean;
	pendingClaims: ClaimState[];
	proofImage?: ProofImage | null;
	now: Date;
}

export type ClaimAction =
	| Rejection
	/** No verification required: pay the claimer immediately */
	| { do: "payout" }
	/** Verification required: record a pending claim and ask the poster */
	| { do: "request-verification" };

export function decideClaim(req: ClaimRequest): ClaimAction {
	const { bounty } = req;
	if (bounty.status !== "open") {
		return { do: "reject", reason: Reasons.notOpen(bounty.id) };
	}
	if (isPastDeadline(bounty, req.now)) {
		return { do: "reject", reason: Reasons.deadlinePassed(bounty.id) };
	}
	if (req.claimerIsBot) {
		return { do: "reject", reason: Reasons.botClaimer };
	}
	if (req.claimerId === bounty.posterId) {
		return { do: "reject", reason: Reasons.ownBounty };
	}
	if (req.pendingClaims.some((c) => c.claimerId === req.claimerId)) {
		return {
			do: "reject",
			reason: Reasons.alreadyPending(bounty.id),
		};
	}
	if (req.proofImage) {
		if (!req.proofImage.contentType?.startsWith("image/")) {
			return { do: "reject", reason: Reasons.proofNotImage };
		}
		if (req.proofImage.size > MAX_PROOF_IMAGE_BYTES) {
			return { do: "reject", reason: Reasons.proofTooLarge };
		}
	}
	return bounty.requiresVerification ? { do: "request-verification" } : { do: "payout" };
}

export interface VerificationRequest {
	bounty: BountyState;
	claim: ClaimState;
	/** All pending claims on the bounty, including `claim` */
	pendingClaims: ClaimState[];
	actorId: string;
	approve: boolean;
}

export type VerificationAction =
	| Rejection
	/** Pay the claimer, close the bounty, and void the other pending claims */
	| { do: "payout"; voidClaimIds: number[] }
	| { do: "reject-claim" };

/**
 * Note that approval is allowed after the deadline: claims can only be created
 * before the deadline, so a late approval is for work that was submitted on time.
 */
export function decideVerification(req: VerificationRequest): VerificationAction {
	const { bounty, claim } = req;
	if (req.actorId !== bounty.posterId) {
		return { do: "reject", reason: Reasons.notPosterVerify };
	}
	if (claim.status !== "pending") {
		return { do: "reject", reason: Reasons.claimResolved };
	}
	if (bounty.status !== "open") {
		return { do: "reject", reason: Reasons.notOpen(bounty.id) };
	}
	if (!req.approve) {
		return { do: "reject-claim" };
	}
	return {
		do: "payout",
		voidClaimIds: req.pendingClaims.filter((c) => c.id !== claim.id).map((c) => c.id),
	};
}

export interface CancelRequest {
	bounty: BountyState;
	pendingClaims: ClaimState[];
	actorId: string;
	/** Admins can cancel anyone's bounty, even with claims awaiting approval */
	actorIsAdmin: boolean;
}

/** Cancelling refunds the poster and voids any pending claims */
export type CancelAction = Rejection | { do: "cancel"; voidClaimIds: number[] };

export function decideCancel(req: CancelRequest): CancelAction {
	const { bounty } = req;
	if (req.actorId !== bounty.posterId && !req.actorIsAdmin) {
		return { do: "reject", reason: Reasons.notPosterCancel };
	}
	if (bounty.status !== "open") {
		return { do: "reject", reason: Reasons.notOpen(bounty.id) };
	}
	if (req.pendingClaims.length > 0 && !req.actorIsAdmin) {
		return {
			do: "reject",
			reason: Reasons.pendingClaimsBlockCancel(bounty.id),
		};
	}
	return { do: "cancel", voidClaimIds: req.pendingClaims.map((c) => c.id) };
}

export interface ExpiryRequest {
	bounty: BountyState;
	pendingClaims: ClaimState[];
	now: Date;
}

export type ExpiryAction = { do: "nothing" } | { do: "expire" };

/**
 * A bounty expires once its deadline has passed, but not while a claim
 * submitted before the deadline is still waiting for the poster's decision.
 */
export function decideExpiry(req: ExpiryRequest): ExpiryAction {
	if (
		req.bounty.status === "open" &&
		isPastDeadline(req.bounty, req.now) &&
		req.pendingClaims.length === 0
	) {
		return { do: "expire" };
	}
	return { do: "nothing" };
}

export const LIST_PAGE_SIZE = 10;

export interface Page {
	/** Zero-based page index, clamped to the valid range */
	page: number;
	pageCount: number;
	offset: number;
}

/**
 * Works out which slice of a list to show. Out-of-range pages are clamped,
 * since the list can shrink between button presses.
 */
export function paginate(
	totalItems: number,
	requestedPage: number,
	pageSize = LIST_PAGE_SIZE,
): Page {
	const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
	const page = Math.min(Math.max(0, Math.trunc(requestedPage) || 0), pageCount - 1);
	return { page, pageCount, offset: page * pageSize };
}
