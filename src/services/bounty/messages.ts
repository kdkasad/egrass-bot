/**
 * All user-facing text for the bounty feature. Edit wording here.
 *
 * This file intentionally does not import discord.js so that logic.ts can use
 * it. Mentions and timestamps are written in Discord's raw markup:
 *   <@USER_ID>       mentions a user
 *   <t:UNIX:R>       renders a relative time, e.g. "in 2 hours"
 *   **bold**, > quote, -# small text
 */

import { formatMoney } from "../../utils/money";

interface BountyText {
	id: number;
	posterId: string;
	task: string;
	amount: number;
	requiresVerification: boolean;
	expiresAt: Date | null;
}

const mention = (userId: string) => `<@${userId}>`;
const relativeTime = (date: Date) => `<t:${Math.floor(date.getTime() / 1000)}:R>`;

/** Why an action was refused. Shown privately to the user, after "🚫 ". */
export const Reasons = {
	emptyTask: "The task description cannot be empty.",
	taskTooLong: (max: number) => `The task description must be at most ${max} characters.`,
	invalidAmount: "The bounty amount must be a positive whole number.",
	invalidTimeLimit:
		'The time limit must be between 1 minute and 365 days (e.g. "30m", "2h", "1d 12h").',
	insufficientBalance: (need: number, have: number) =>
		`Insufficient balance: need ${formatMoney(need)}, have ${formatMoney(have)}.`,

	noSuchBounty: (id: number) => `There is no bounty #${id}.`,
	notOpen: (id: number) => `Bounty #${id} is no longer open.`,
	deadlinePassed: (id: number) => `The deadline for bounty #${id} has passed.`,
	botClaimer: "Bots cannot claim bounties.",
	ownBounty: "You cannot claim your own bounty.",
	alreadyPending: (id: number) => `You already have a claim on bounty #${id} awaiting approval.`,
	proofNotImage: "The proof attachment must be an image.",
	proofTooLarge: "The proof image must be at most 10 MB.",

	claimMissing: "This claim no longer exists.",
	notPosterVerify: "Only the bounty's poster can approve or reject claims.",
	claimResolved: "This claim has already been resolved.",

	notPosterCancel: "Only the bounty's poster or an admin can cancel it.",
	pendingClaimsBlockCancel: (id: number) =>
		`Bounty #${id} has claims awaiting your approval. Approve or reject them first.`,
};

/** Text for /bounty list (one line per bounty) */
export const ListText = {
	header: (posterId: string | null) =>
		posterId === null
			? "📋 **Open bounties**"
			: `📋 **Open bounties posted by ${mention(posterId)}**`,
	empty: "None right now.",
	/** Longer tasks are cut off with "…" */
	taskMaxLength: 80,
	noDeadline: "no time limit",
	deadline: (expiresAt: Date) => `expires ${relativeTime(expiresAt)}`,
	/** Deadline has passed but a claim is still waiting for the poster */
	awaiting: "⏳ awaiting approval",
	approvalMarker: " | 🔍",
	line: (b: BountyText, task: string, deadline: string) =>
		`**#${b.id}** | ${formatMoney(b.amount)} | ${task} | by ${mention(b.posterId)} | ${deadline}` +
		(b.requiresVerification ? ListText.approvalMarker : ""),
	/** `page` starts at 1 */
	footer: (page: number, pageCount: number, total: number) =>
		`-# Page ${page}/${pageCount} | ${total} open ${total === 1 ? "bounty" : "bounties"} | 🔍 = needs approval | claim with \`/bounty claim id:#\``,
};

function truncate(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** Messages the bot posts */
export const Messages = {
	rejection: (reason: string) => `🚫 ${reason}`,
	error: (message: string) => `⚠️ Error: ${message}`,

	posted: (b: BountyText) =>
		`📌 ${mention(b.posterId)} posted **bounty #${b.id}** for **${formatMoney(b.amount)}**\n` +
		`> ${b.task}\n` +
		`-# ${b.expiresAt === null ? ListText.noDeadline : ListText.deadline(b.expiresAt)}` +
		(b.requiresVerification ? " · requires poster approval" : "") +
		` · claim it with \`/bounty claim id:${b.id}\``,

	/** One page of /bounty list */
	list: (
		rows: BountyText[],
		posterId: string | null,
		page: { page: number; pageCount: number; total: number },
		now: Date,
	): string => {
		const header = ListText.header(posterId);
		if (rows.length === 0) return `${header}\n${ListText.empty}`;
		const lines = rows.map((b) => {
			const deadline =
				b.expiresAt === null
					? ListText.noDeadline
					: b.expiresAt <= now
						? ListText.awaiting
						: ListText.deadline(b.expiresAt);
			return ListText.line(b, truncate(b.task, ListText.taskMaxLength), deadline);
		});
		return [header, ...lines, ListText.footer(page.page, page.pageCount, page.total)].join(
			"\n",
		);
	},

	instantPayout: (b: BountyText, claimerId: string) =>
		`🏆 ${mention(claimerId)} completed **bounty #${b.id}** and received **${formatMoney(b.amount)}** from ${mention(b.posterId)}\n> ${b.task}`,

	verificationRequest: (b: BountyText, claimerId: string, proof: string | null) =>
		`🔍 ${mention(b.posterId)}, ${mention(claimerId)} says they completed **bounty #${b.id}**\n` +
		`> ${b.task}` +
		(proof ? `\n**Proof:** ${proof}` : ""),
	/** Appended to the verification request once the poster decides */
	verdictApproved: (b: BountyText, claimerId: string) =>
		`✅ Approved: ${mention(claimerId)} received **${formatMoney(b.amount)}**`,
	verdictRejected: (b: BountyText) => `❌ Rejected by ${mention(b.posterId)}`,
	claimApproved: (b: BountyText, claimerId: string) =>
		`🏆 ${mention(claimerId)}, your claim on **bounty #${b.id}** was approved and you received **${formatMoney(b.amount)}**!`,
	claimRejected: (b: BountyText, claimerId: string) =>
		`${mention(claimerId)}, your claim on **bounty #${b.id}** was rejected.`,

	cancelled: (b: BountyText) =>
		`🗑️ ${mention(b.posterId)} cancelled **bounty #${b.id}**. ${formatMoney(b.amount)} was returned to them.\n> ${b.task}`,
	/** An admin cancelled someone else's bounty */
	cancelledByAdmin: (b: BountyText, adminId: string) =>
		`🗑️ ${mention(adminId)} cancelled ${mention(b.posterId)}'s **bounty #${b.id}**. ${formatMoney(b.amount)} was returned to ${mention(b.posterId)}.\n> ${b.task}`,

	/** Posted in the bots channel */
	expired: (b: BountyText) =>
		`⌛ ${mention(b.posterId)}, nobody completed **bounty #${b.id}** in time. ${formatMoney(b.amount)} was returned to you.\n> ${b.task}`,
};

export const ButtonLabels = {
	approve: (amount: number) => `Approve & pay ${formatMoney(amount)}`,
	reject: "Reject",
	previous: "◀ Previous",
	next: "Next ▶",
};

/** Descriptions shown in Discord's slash-command picker (max 100 characters each) */
export const CommandText = {
	command: "Post and claim bounties on the Egrass Exchange",
	create: "Post a bounty. The amount is held from your balance until it closes.",
	createTask: "What needs to be done",
	createAmount: "Reward ($)",
	createTimeLimit: 'How long until it expires, e.g. "30m", "2h", "1d 12h"',
	createVerification: "Require your approval before paying a claimer (default: no)",
	list: "List open bounties",
	listUser: "Only show bounties posted by this user",
	claim: "Claim a bounty you completed",
	claimId: "Bounty ID",
	claimProof: "Proof or notes for the poster",
	claimProofImage: "Screenshot or photo as proof",
	cancel: "Cancel your bounty and get your money back",
	cancelId: "Bounty ID",
};
