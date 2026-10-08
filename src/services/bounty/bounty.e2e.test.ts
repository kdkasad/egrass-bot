/**
 * End-to-end tests for BountyService. These run the real service against a
 * real (in-memory, fully migrated) SQLite database. Discord is replaced by a
 * fake that records every reply, button, and message, and time is controlled
 * with MockTimeSource so deadlines can be tested without waiting.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonInteraction,
	ChatInputCommandInteraction,
} from "discord.js";
import { asc, eq, sql } from "drizzle-orm";

import { BountyService } from ".";
import { Channels, Users } from "../../consts";
import {
	bounties,
	bountyClaims,
	exchangeBalances,
	exchangeTransactions,
	members,
} from "../../db/schema";
import { MockTimeSource } from "../../utils/time";
import { ListText, Messages, Reasons } from "./messages";
import type { CronService } from "../cron";
import { DatabaseService } from "../database";
import type { DiscordService } from "../discord";
import type { EnvService } from "../env";

const POSTER = "100000000000000001";
const ALICE = "100000000000000002";
const BOB = "100000000000000003";
const BOT = "100000000000000009";
/** A user who is not in the members table (e.g. joined while the bot was down) */
const STRANGER = "100000000000000099";

type Payload = {
	content?: string;
	components?: ActionRowBuilder<ButtonBuilder>[];
	allowedMentions?: { users?: string[] };
	flags?: unknown[];
	files?: { attachment: string; name: string }[];
};

type Handler<T> = (interaction: T) => Promise<void>;

class FakeDiscord {
	command: Handler<ChatInputCommandInteraction> | undefined;
	buttons = new Map<string, Handler<ButtonInteraction>>();
	sent: (Payload & { channelId: string })[] = [];

	registerSlashCommand(_spec: unknown, handler: Handler<ChatInputCommandInteraction>) {
		this.command = handler;
	}
	registerButtonHandler(prefix: string, handler: Handler<ButtonInteraction>) {
		this.buttons.set(prefix, handler);
	}
	async sendMessage(channelId: string, payload: Payload) {
		this.sent.push({ channelId, ...payload });
	}
}

class FakeCron {
	jobs = new Map<string, () => Promise<void>>();
	createJob(name: string, _schedule: string, callback: () => Promise<void>) {
		this.jobs.set(name, callback);
	}
}

interface User {
	id: string;
	bot: boolean;
}

interface Attachment {
	url: string;
	name: string;
	size: number;
	contentType: string | null;
}

const SCREENSHOT: Attachment = {
	url: "https://cdn.discordapp.com/attachments/1/2/screenshot.png",
	name: "screenshot.png",
	size: 300_000,
	contentType: "image/png",
};

/** Recorded result of a fake interaction */
interface Recorded {
	replies: Payload[];
	updates: Payload[];
	followUps: Payload[];
}

function isEphemeral(p: Payload): boolean {
	return (p.flags ?? []).length > 0;
}

/** Custom IDs of the buttons attached to a reply */
function buttonIds(p: Payload): string[] {
	return (p.components ?? []).flatMap((row) =>
		row.toJSON().components.map((c) => ("custom_id" in c ? c.custom_id : "")),
	);
}

class Harness {
	readonly time = new MockTimeSource();
	readonly discord = new FakeDiscord();
	readonly cron = new FakeCron();
	db!: DatabaseService;

	async init() {
		const env = {
			vars: { DATABASE_FILE: ":memory:", DISABLED_FEATURES: new Set<string>() },
		} as unknown as EnvService;
		this.db = await DatabaseService.new(env, this.cron as unknown as CronService);
		new BountyService(
			env,
			this.discord as unknown as DiscordService,
			this.db,
			this.cron as unknown as CronService,
			this.time,
		);
		this.time.setTime(new Date("2026-01-01T00:00:00Z"));
		this.addMember(POSTER, 100);
		this.addMember(ALICE, 0);
		this.addMember(BOB, 0);
		this.addMember(BOT, 0, true);
		return this;
	}

	addMember(id: string, balance: number, isBot = false, displayName = id) {
		this.db.querySync("seed member", (tx) => {
			tx.insert(members)
				.values({ user_id: id, display_name: displayName, username: id, is_bot: isBot })
				.run();
			tx.insert(exchangeBalances).values({ user_id: id, balance }).run();
		});
	}

	user(id: string): User {
		return { id, bot: id === BOT };
	}

	/** Runs `/bounty <subcommand>` as `userId` with the given options */
	async run(
		userId: string,
		subcommand: "create" | "list" | "claim" | "cancel",
		options: Record<string, string | number | boolean | User | Attachment> = {},
	): Promise<Recorded> {
		const rec: Recorded = { replies: [], updates: [], followUps: [] };
		const get = (name: string) => options[name] ?? null;
		const interaction = {
			id: "interaction",
			replied: false,
			user: this.user(userId),
			options: {
				getSubcommand: () => subcommand,
				getString: get,
				getInteger: get,
				getBoolean: get,
				getUser: get,
				getAttachment: get,
			},
			reply: async (p: Payload) => {
				rec.replies.push(p);
				interaction.replied = true;
			},
			followUp: async (p: Payload) => void rec.followUps.push(p),
		};
		await this.discord.command!(interaction as unknown as ChatInputCommandInteraction);
		return rec;
	}

	/**
	 * Clicks a button (by custom ID) on a message as `userId`.
	 * `failFirstFollowUp` simulates Discord failing to send the first follow-up.
	 */
	async click(
		userId: string,
		customId: string,
		messageContent = "",
		{ failFirstFollowUp = false } = {},
	): Promise<Recorded> {
		const rec: Recorded = { replies: [], updates: [], followUps: [] };
		let followUpShouldFail = failFirstFollowUp;
		const interaction = {
			id: "interaction",
			replied: false,
			customId,
			user: this.user(userId),
			message: { content: messageContent },
			reply: async (p: Payload) => {
				rec.replies.push(p);
				interaction.replied = true;
			},
			update: async (p: Payload) => {
				rec.updates.push(p);
				interaction.replied = true;
			},
			followUp: async (p: Payload) => {
				if (followUpShouldFail) {
					followUpShouldFail = false;
					throw new Error("Discord is down");
				}
				rec.followUps.push(p);
			},
		};
		const prefix = customId.split(":")[0]!;
		await this.discord.buttons.get(prefix)!(interaction as unknown as ButtonInteraction);
		return rec;
	}

	async runExpiryJob() {
		await this.cron.jobs.get("expire bounties")!();
	}

	balance(id: string): number {
		return this.db.querySync(
			"balance",
			(tx) =>
				tx.select().from(exchangeBalances).where(eq(exchangeBalances.user_id, id)).get()
					?.balance ?? 0,
		);
	}

	bounty(id: number) {
		return this.db.querySync("bounty", (tx) =>
			tx.select().from(bounties).where(eq(bounties.id, id)).get(),
		);
	}

	claims(bountyId: number) {
		return this.db.querySync("claims", (tx) =>
			tx
				.select()
				.from(bountyClaims)
				.where(eq(bountyClaims.bounty_id, bountyId))
				.orderBy(asc(bountyClaims.id))
				.all(),
		);
	}

	transactions() {
		return this.db.querySync("transactions", (tx) =>
			tx.select().from(exchangeTransactions).all(),
		);
	}

	/** All money in the system: balances plus amounts held in open bounties */
	totalMoney(): number {
		return this.db.querySync("total money", (tx) => {
			const balances = tx
				.select({ total: sql<number>`coalesce(sum(${exchangeBalances.balance}), 0)` })
				.from(exchangeBalances)
				.get()!.total;
			const held = tx
				.select({ total: sql<number>`coalesce(sum(${bounties.amount}), 0)` })
				.from(bounties)
				.where(eq(bounties.status, "open"))
				.get()!.total;
			return balances + held;
		});
	}
}

const rejected = (reason: string) => Messages.rejection(reason);

/** The bounty as Messages functions expect it */
function bountyText(id: number, task: string, amount: number, posterId = POSTER) {
	return { id, posterId, task, amount, requiresVerification: false, expiresAt: null };
}

/** Asserts a single public reply and returns it */
function onlyPublicReply(rec: Recorded): Payload {
	expect(rec.replies).toHaveLength(1);
	expect(isEphemeral(rec.replies[0]!)).toBe(false);
	return rec.replies[0]!;
}

/** Asserts a single ephemeral reply and returns its content */
function onlyEphemeralReply(rec: Recorded): string {
	expect(rec.replies).toHaveLength(1);
	expect(isEphemeral(rec.replies[0]!)).toBe(true);
	return rec.replies[0]!.content!;
}

let h: Harness;
beforeEach(async () => {
	h = await new Harness().init();
});

describe("/bounty create", () => {
	test("holds the amount from the poster's balance", async () => {
		const reply = onlyPublicReply(
			await h.run(POSTER, "create", { task: "Fix my code", amount: 30 }),
		);
		expect(reply.content).toBe(Messages.posted(bountyText(1, "Fix my code", 30)));
		expect(h.balance(POSTER)).toBe(70);
		expect(h.bounty(1)).toMatchObject({
			poster_id: POSTER,
			task: "Fix my code",
			amount: 30,
			status: "open",
			expires_at: null,
			requires_verification: false,
		});
		// Holding money is not a transaction; only payouts are
		expect(h.transactions()).toHaveLength(0);
	});

	test("stores the deadline from the time limit", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 1, time_limit: "1d 2h" });
		const expected = h.time.now().getTime() / 1000 + 26 * 60 * 60;
		expect(h.bounty(1)!.expires_at).toBe(expected);
	});

	test("rejects insufficient balance without changing anything", async () => {
		const msg = onlyEphemeralReply(await h.run(POSTER, "create", { task: "t", amount: 101 }));
		expect(msg).toBe(rejected(Reasons.insufficientBalance(101, 100)));
		expect(h.balance(POSTER)).toBe(100);
		expect(h.bounty(1)).toBeUndefined();
	});

	test("rejects a time limit too large to store", async () => {
		const msg = onlyEphemeralReply(
			await h.run(POSTER, "create", { task: "t", amount: 1, time_limit: "999999999d" }),
		);
		expect(msg).toBe(rejected(Reasons.invalidTimeLimit));
		expect(h.bounty(1)).toBeUndefined();
		expect(h.balance(POSTER)).toBe(100);
	});

	test("rejects an unparseable time limit", async () => {
		const msg = onlyEphemeralReply(
			await h.run(POSTER, "create", { task: "t", amount: 1, time_limit: "tomorrow" }),
		);
		expect(msg).toBe(rejected(Reasons.invalidTimeLimit));
		expect(h.balance(POSTER)).toBe(100);
	});
});

describe("/bounty claim without verification", () => {
	test("pays the claimer immediately and records a transaction", async () => {
		await h.run(POSTER, "create", { task: "Fix my code", amount: 30 });
		const reply = onlyPublicReply(await h.run(ALICE, "claim", { id: 1 }));

		expect(reply.content).toBe(Messages.instantPayout(bountyText(1, "Fix my code", 30), ALICE));
		expect(h.balance(POSTER)).toBe(70);
		expect(h.balance(ALICE)).toBe(30);
		expect(h.bounty(1)).toMatchObject({ status: "completed", winner_id: ALICE });
		expect(h.claims(1)).toMatchObject([{ claimer_id: ALICE, status: "approved" }]);
		expect(h.transactions()).toMatchObject([
			{ sender_id: POSTER, recipient_id: ALICE, amount: 30, memo: "Bounty #1: Fix my code" },
		]);
		expect(h.bounty(1)!.transaction_id).toBe(h.transactions()[0]!.id);
	});

	test("a completed bounty cannot be claimed twice", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30 });
		await h.run(ALICE, "claim", { id: 1 });
		const msg = onlyEphemeralReply(await h.run(BOB, "claim", { id: 1 }));
		expect(msg).toBe(rejected(Reasons.notOpen(1)));
		expect(h.balance(BOB)).toBe(0);
	});

	test("rejects claiming your own bounty, bots, and unknown bounties", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30 });
		expect(onlyEphemeralReply(await h.run(POSTER, "claim", { id: 1 }))).toBe(
			rejected(Reasons.ownBounty),
		);
		expect(onlyEphemeralReply(await h.run(BOT, "claim", { id: 1 }))).toBe(
			rejected(Reasons.botClaimer),
		);
		expect(onlyEphemeralReply(await h.run(ALICE, "claim", { id: 42 }))).toBe(
			rejected(Reasons.noSuchBounty(42)),
		);
		expect(h.bounty(1)!.status).toBe("open");
	});

	test("a claim from someone not in the members table fails cleanly", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30 });
		// STRANGER is not in the members table, so the insert violates a foreign key
		const msg = onlyEphemeralReply(await h.run(STRANGER, "claim", { id: 1 }));
		expect(msg).toStartWith("⚠️ Error:");
		expect(h.bounty(1)!.status).toBe("open");
		expect(h.claims(1)).toHaveLength(0);
		expect(h.balance(POSTER)).toBe(70);
		expect(h.transactions()).toHaveLength(0);
	});
});

describe("/bounty claim with verification", () => {
	async function claimWithVerification(claimer: string, proof?: string) {
		const rec = await h.run(claimer, "claim", proof ? { id: 1, proof } : { id: 1 });
		const reply = onlyPublicReply(rec);
		const [approveId, rejectId] = buttonIds(reply);
		return { reply, approveId: approveId!, rejectId: rejectId! };
	}

	beforeEach(async () => {
		await h.run(POSTER, "create", { task: "Fix my code", amount: 30, verification: true });
	});

	test("pings the poster with approve/reject buttons and holds the money", async () => {
		const { reply, approveId, rejectId } = await claimWithVerification(ALICE, "see PR #3");
		expect(reply.content).toContain(`<@${POSTER}>`);
		expect(reply.content).toContain("see PR #3");
		expect(reply.allowedMentions).toEqual({ users: [POSTER] });
		expect(approveId).toBe("bounty/approve:1");
		expect(rejectId).toBe("bounty/reject:1");
		expect(h.balance(ALICE)).toBe(0);
		expect(h.claims(1)).toMatchObject([{ status: "pending", proof: "see PR #3" }]);
	});

	test("attaches the proof image to the claim message for the poster", async () => {
		const reply = onlyPublicReply(await h.run(ALICE, "claim", { id: 1, image: SCREENSHOT }));
		expect(reply.files).toEqual([{ attachment: SCREENSHOT.url, name: "screenshot.png" }]);
		expect(buttonIds(reply)).toHaveLength(2);
	});

	test("rejects a non-image proof without recording a claim", async () => {
		const msg = onlyEphemeralReply(
			await h.run(ALICE, "claim", {
				id: 1,
				image: { ...SCREENSHOT, name: "notes.pdf", contentType: "application/pdf" },
			}),
		);
		expect(msg).toBe(rejected(Reasons.proofNotImage));
		expect(h.claims(1)).toHaveLength(0);
	});

	test("only the poster can approve", async () => {
		const { approveId } = await claimWithVerification(ALICE);
		const msg = onlyEphemeralReply(await h.click(ALICE, approveId));
		expect(msg).toBe(rejected(Reasons.notPosterVerify));
		expect(h.balance(ALICE)).toBe(0);
	});

	test("approving pays the claimer, removes the buttons, and pings them", async () => {
		const { reply, approveId } = await claimWithVerification(ALICE);
		const rec = await h.click(POSTER, approveId, reply.content);

		expect(rec.updates).toHaveLength(1);
		expect(rec.updates[0]!.components).toEqual([]);
		const bounty = { ...bountyText(1, "Fix my code", 30), requiresVerification: true };
		expect(rec.updates[0]!.content).toBe(
			`${reply.content}\n\n${Messages.verdictApproved(bounty, ALICE)}`,
		);
		expect(rec.followUps[0]!.content).toBe(Messages.claimApproved(bounty, ALICE));
		expect(rec.followUps).toHaveLength(1);
		expect(rec.followUps[0]!.allowedMentions).toEqual({ users: [ALICE] });
		expect(h.balance(ALICE)).toBe(30);
		expect(h.balance(POSTER)).toBe(70);
		expect(h.bounty(1)).toMatchObject({ status: "completed", winner_id: ALICE });
	});

	test("if pinging the claimer fails, the payout stands and the poster sees the error", async () => {
		const { reply, approveId } = await claimWithVerification(ALICE);
		const rec = await h.click(POSTER, approveId, reply.content, { failFirstFollowUp: true });

		// The button was already answered, so the error must be a follow-up, not a reply
		expect(rec.replies).toHaveLength(0);
		expect(rec.followUps).toHaveLength(1);
		expect(rec.followUps[0]!.content).toBe(Messages.error("Discord is down"));
		expect(isEphemeral(rec.followUps[0]!)).toBe(true);
		expect(h.balance(ALICE)).toBe(30);
		expect(h.bounty(1)!.status).toBe("completed");
	});

	test("double-clicking approve does not pay twice", async () => {
		const { approveId } = await claimWithVerification(ALICE);
		await h.click(POSTER, approveId);
		const msg = onlyEphemeralReply(await h.click(POSTER, approveId));
		expect(msg).toBe(rejected(Reasons.claimResolved));
		expect(h.balance(ALICE)).toBe(30);
		expect(h.transactions()).toHaveLength(1);
	});

	test("approving one claim voids the other pending claims", async () => {
		const alice = await claimWithVerification(ALICE);
		const bob = await claimWithVerification(BOB);
		await h.click(POSTER, bob.approveId);

		expect(h.balance(BOB)).toBe(30);
		expect(h.balance(ALICE)).toBe(0);
		expect(h.claims(1)).toMatchObject([
			{ claimer_id: ALICE, status: "voided" },
			{ claimer_id: BOB, status: "approved" },
		]);
		// Alice's buttons are now dead
		expect(onlyEphemeralReply(await h.click(POSTER, alice.approveId))).toBe(
			rejected(Reasons.claimResolved),
		);
	});

	test("rejecting keeps the bounty open and the money held", async () => {
		const { rejectId } = await claimWithVerification(ALICE);
		const rec = await h.click(POSTER, rejectId);

		const bounty = { ...bountyText(1, "Fix my code", 30), requiresVerification: true };
		expect(rec.updates[0]!.content).toEndWith(Messages.verdictRejected(bounty));
		expect(rec.followUps[0]!.content).toBe(Messages.claimRejected(bounty, ALICE));
		expect(h.bounty(1)!.status).toBe("open");
		expect(h.claims(1)).toMatchObject([{ status: "rejected" }]);
		expect(h.balance(POSTER)).toBe(70);
		expect(h.balance(ALICE)).toBe(0);

		// Alice can try again after a rejection
		await claimWithVerification(ALICE);
		expect(h.claims(1)).toHaveLength(2);
	});

	test("cannot submit two pending claims at once", async () => {
		await claimWithVerification(ALICE);
		const msg = onlyEphemeralReply(await h.run(ALICE, "claim", { id: 1 }));
		expect(msg).toBe(rejected(Reasons.alreadyPending(1)));
	});
});

describe("/bounty cancel", () => {
	test("refunds the poster", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30 });
		const reply = onlyPublicReply(await h.run(POSTER, "cancel", { id: 1 }));
		expect(reply.content).toBe(Messages.cancelled(bountyText(1, "t", 30)));
		expect(h.balance(POSTER)).toBe(100);
		expect(h.bounty(1)!.status).toBe("cancelled");
	});

	test("other users cannot cancel", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30 });
		expect(onlyEphemeralReply(await h.run(ALICE, "cancel", { id: 1 }))).toBe(
			rejected(Reasons.notPosterCancel),
		);
		expect(h.balance(POSTER)).toBe(70);
	});

	test("is blocked while a claim awaits approval", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30, verification: true });
		await h.run(ALICE, "claim", { id: 1 });
		expect(onlyEphemeralReply(await h.run(POSTER, "cancel", { id: 1 }))).toBe(
			rejected(Reasons.pendingClaimsBlockCancel(1)),
		);
		expect(h.balance(POSTER)).toBe(70);
	});

	describe("admins", () => {
		beforeEach(() => {
			h.addMember(Users.Kian, 0);
			h.addMember(Users.Alex, 0);
		});

		for (const [name, admin] of [
			["Kian", Users.Kian],
			["Alex", Users.Alex],
		] as const) {
			test(`${name} can cancel someone else's bounty; the poster gets the refund`, async () => {
				await h.run(POSTER, "create", { task: "t", amount: 30 });
				const reply = onlyPublicReply(await h.run(admin, "cancel", { id: 1 }));

				expect(reply.content).toBe(
					Messages.cancelledByAdmin(bountyText(1, "t", 30), admin),
				);
				// The poster is pinged so they know
				expect(reply.allowedMentions).toEqual({ users: [POSTER] });
				expect(h.balance(POSTER)).toBe(100);
				expect(h.balance(admin)).toBe(0);
				expect(h.bounty(1)!.status).toBe("cancelled");
			});
		}

		test("an admin can cancel with a claim awaiting approval, which voids it", async () => {
			await h.run(POSTER, "create", { task: "t", amount: 30, verification: true });
			const claim = onlyPublicReply(await h.run(ALICE, "claim", { id: 1 }));

			onlyPublicReply(await h.run(Users.Kian, "cancel", { id: 1 }));
			expect(h.balance(POSTER)).toBe(100);
			expect(h.claims(1)).toMatchObject([{ claimer_id: ALICE, status: "voided" }]);

			// The poster can no longer approve the voided claim
			const [approveId] = buttonIds(claim);
			expect(onlyEphemeralReply(await h.click(POSTER, approveId!))).toBe(
				rejected(Reasons.claimResolved),
			);
			expect(h.balance(ALICE)).toBe(0);
		});

		test("an admin cancelling their own bounty gets the normal message", async () => {
			h.db.querySync("give alex money", (tx) =>
				tx
					.update(exchangeBalances)
					.set({ balance: 50 })
					.where(eq(exchangeBalances.user_id, Users.Alex))
					.run(),
			);
			await h.run(Users.Alex, "create", { task: "mine", amount: 20 });
			const reply = onlyPublicReply(await h.run(Users.Alex, "cancel", { id: 1 }));
			expect(reply.content).toBe(Messages.cancelled(bountyText(1, "mine", 20, Users.Alex)));
			expect(h.balance(Users.Alex)).toBe(50);
		});
	});

	test("cannot cancel twice for a double refund", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30 });
		await h.run(POSTER, "cancel", { id: 1 });
		expect(onlyEphemeralReply(await h.run(POSTER, "cancel", { id: 1 }))).toBe(
			rejected(Reasons.notOpen(1)),
		);
		expect(h.balance(POSTER)).toBe(100);
	});
});

describe("expiry", () => {
	test("refunds the poster after the deadline and notifies the bots channel", async () => {
		await h.run(POSTER, "create", { task: "Fix my code", amount: 30, time_limit: "1h" });

		h.time.advance({ minutes: 59 });
		await h.runExpiryJob();
		expect(h.bounty(1)!.status).toBe("open");
		expect(h.discord.sent).toHaveLength(0);

		h.time.advance({ minutes: 1 });
		await h.runExpiryJob();
		expect(h.bounty(1)!.status).toBe("expired");
		expect(h.balance(POSTER)).toBe(100);
		expect(h.discord.sent).toHaveLength(1);
		expect(h.discord.sent[0]).toMatchObject({
			channelId: Channels.Wordle,
			allowedMentions: { users: [POSTER] },
		});
		expect(h.discord.sent[0]!.content).toBe(Messages.expired(bountyText(1, "Fix my code", 30)));

		// Running again does not refund twice
		await h.runExpiryJob();
		expect(h.balance(POSTER)).toBe(100);
		expect(h.discord.sent).toHaveLength(1);
	});

	test("an expired bounty can no longer be claimed", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30, time_limit: "1h" });
		h.time.advance({ hours: 1 });
		// Even before the expiry job runs, the deadline is enforced
		expect(onlyEphemeralReply(await h.run(ALICE, "claim", { id: 1 }))).toBe(
			rejected(Reasons.deadlinePassed(1)),
		);
	});

	test("waits for a pending claim, which can still be approved after the deadline", async () => {
		await h.run(POSTER, "create", {
			task: "t",
			amount: 30,
			time_limit: "1h",
			verification: true,
		});
		const claim = onlyPublicReply(await h.run(ALICE, "claim", { id: 1 }));

		h.time.advance({ hours: 2 });
		await h.runExpiryJob();
		expect(h.bounty(1)!.status).toBe("open");
		expect(h.discord.sent).toHaveLength(0);

		await h.click(POSTER, buttonIds(claim)[0]!);
		expect(h.balance(ALICE)).toBe(30);
		expect(h.bounty(1)!.status).toBe("completed");
	});

	test("expires on the next run once the pending claim is rejected", async () => {
		await h.run(POSTER, "create", {
			task: "t",
			amount: 30,
			time_limit: "1h",
			verification: true,
		});
		const claim = onlyPublicReply(await h.run(ALICE, "claim", { id: 1 }));
		h.time.advance({ hours: 2 });
		await h.runExpiryJob();
		expect(h.bounty(1)!.status).toBe("open");

		await h.click(POSTER, buttonIds(claim)[1]!);
		await h.runExpiryJob();
		expect(h.bounty(1)!.status).toBe("expired");
		expect(h.balance(POSTER)).toBe(100);
	});

	test("bounties without a time limit never expire", async () => {
		await h.run(POSTER, "create", { task: "t", amount: 30 });
		h.time.advance({ days: 3650 });
		await h.runExpiryJob();
		expect(h.bounty(1)!.status).toBe("open");
	});
});

describe("/bounty list", () => {
	/** Bounty IDs shown in the list, in order */
	const ids = (p: Payload) =>
		[...p.content!.matchAll(/\*\*#(\d+)\*\*/g)].map((m) => Number(m[1]));
	const buttons = (p: Payload) =>
		(p.components ?? []).flatMap((row) =>
			row.toJSON().components.map((c) => ({
				id: "custom_id" in c ? c.custom_id : "",
				disabled: c.disabled ?? false,
			})),
		);
	const listReply = async (userId: string, options = {}) => {
		const rec = await h.run(userId, "list", options);
		expect(rec.replies).toHaveLength(1);
		expect(isEphemeral(rec.replies[0]!)).toBe(true);
		return rec.replies[0]!;
	};

	test("shows only open bounties, optionally filtered by poster", async () => {
		h.addMember("100000000000000004", 50);
		await h.run(POSTER, "create", { task: "First task", amount: 10 });
		await h.run(POSTER, "create", { task: "Cancelled task", amount: 10 });
		await h.run("100000000000000004", "create", { task: "Other poster", amount: 5 });
		await h.run(POSTER, "cancel", { id: 2 });

		const all = (await listReply(ALICE)).content!;
		expect(all).toContain("First task");
		expect(all).toContain("Other poster");
		expect(all).not.toContain("Cancelled task");

		const mine = await listReply(ALICE, { user: h.user(POSTER) });
		expect(mine.content).toStartWith(ListText.header(POSTER));
		expect(mine.content).toContain("First task");
		expect(mine.content).not.toContain("Other poster");
	});

	test("renders one line per bounty with clickable posters and live deadlines", async () => {
		const KAYMO = "100000000000000006";
		const EDOUARD = "100000000000000007";
		h.addMember(KAYMO, 500);
		h.addMember(EDOUARD, 500);
		await h.run(KAYMO, "create", {
			task: "Review my PR for the bounty feature before Friday",
			amount: 25,
			time_limit: "2d 3h",
			verification: true,
		});
		await h.run(EDOUARD, "create", { task: "Touch grass", amount: 100 });
		await h.run(KAYMO, "create", { task: "Wordle", amount: 3, time_limit: "45m" });

		expect((await listReply(ALICE)).content).toMatchInlineSnapshot(`
		  "📋 **Open bounties**
		  **#1** | $25 | Review my PR for the bounty feature before Friday | by <@100000000000000006> | expires <t:1767409200:R> | 🔍
		  **#2** | $100 | Touch grass | by <@100000000000000007> | no time limit
		  **#3** | $3 | Wordle | by <@100000000000000006> | expires <t:1767228300:R>
		  -# Page 1/1 | 3 open bounties | 🔍 = needs approval | claim with \`/bounty claim id:#\`"
		`);
	});

	test("shows a pending claim past its deadline as awaiting approval", async () => {
		await h.run(POSTER, "create", {
			task: "t",
			amount: 5,
			time_limit: "1h",
			verification: true,
		});
		await h.run(ALICE, "claim", { id: 1 });
		h.time.advance({ hours: 2 });
		await h.runExpiryJob();
		expect((await listReply(ALICE)).content).toContain(
			ListText.awaiting + ListText.approvalMarker,
		);
	});

	test("says when there is nothing to show", async () => {
		expect((await listReply(ALICE)).content).toBe(
			`${ListText.header(null)}\n${ListText.empty}`,
		);
	});

	describe("pagination", () => {
		const MANY = "100000000000000005";

		beforeEach(async () => {
			h.addMember(MANY, 10_000);
			for (let i = 0; i < 25; i++) {
				await h.run(MANY, "create", {
					task: `Task ${i + 1} ${"x".repeat(150)}`,
					amount: 1,
				});
			}
		});

		test("shows 10 per page with Previous/Next buttons", async () => {
			const first = await listReply(ALICE);
			expect(ids(first)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
			expect(first.content).toEndWith(ListText.footer(1, 3, 25));
			expect(buttons(first)).toEqual([
				{ id: "bounty/list:-1:", disabled: true },
				{ id: "bounty/list:1:", disabled: false },
			]);
		});

		test("Next and Previous move between pages", async () => {
			const first = await listReply(ALICE);

			const second = (await h.click(ALICE, buttons(first)[1]!.id)).updates[0]!;
			expect(ids(second)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
			expect(buttons(second).map((b) => b.disabled)).toEqual([false, false]);

			const third = (await h.click(ALICE, buttons(second)[1]!.id)).updates[0]!;
			expect(ids(third)).toEqual([21, 22, 23, 24, 25]);
			expect(third.content).toEndWith(ListText.footer(3, 3, 25));
			expect(buttons(third).map((b) => b.disabled)).toEqual([false, true]);

			const back = (await h.click(ALICE, buttons(third)[0]!.id)).updates[0]!;
			expect(ids(back)).toEqual(ids(second));
		});

		test("keeps the user filter across pages", async () => {
			await h.run(POSTER, "create", { task: "Not by MANY", amount: 1 });
			const first = await listReply(ALICE, { user: h.user(MANY) });
			expect(buttons(first)[1]!.id).toBe(`bounty/list:1:${MANY}`);
			const second = (await h.click(ALICE, buttons(first)[1]!.id)).updates[0]!;
			expect(second.content).toStartWith(ListText.header(MANY));
			expect(second.content).not.toContain("Not by MANY");
		});

		test("clamps to the last page when the list shrinks between clicks", async () => {
			const first = await listReply(ALICE);
			const second = (await h.click(ALICE, buttons(first)[1]!.id)).updates[0]!;
			// 20 bounties get cancelled, leaving only 5 (one page)
			for (let id = 1; id <= 20; id++) await h.run(MANY, "cancel", { id });
			const next = (await h.click(ALICE, buttons(second)[1]!.id)).updates[0]!;
			expect(ids(next)).toEqual([21, 22, 23, 24, 25]);
			expect(next.components).toEqual([]);
		});

		test("every page stays under Discord's 2000 character limit", async () => {
			let page = await listReply(ALICE);
			for (let i = 0; i < 3; i++) {
				expect(page.content!.length).toBeLessThanOrEqual(2000);
				const next = buttons(page)[1];
				if (!next || next.disabled) break;
				page = (await h.click(ALICE, next.id)).updates[0]!;
			}
		});
	});
});

test("money is never created or destroyed across a full session", async () => {
	const start = h.totalMoney();

	await h.run(POSTER, "create", { task: "instant", amount: 10 }); // #1
	await h.run(POSTER, "create", { task: "verified", amount: 20, verification: true }); // #2
	await h.run(POSTER, "create", { task: "cancelled", amount: 5 }); // #3
	await h.run(POSTER, "create", { task: "expires", amount: 15, time_limit: "1h" }); // #4
	await h.run(POSTER, "create", { task: "too much", amount: 1000 }); // rejected
	expect(h.totalMoney()).toBe(start);

	await h.run(ALICE, "claim", { id: 1 });
	const claim = onlyPublicReply(await h.run(BOB, "claim", { id: 2 }));
	await h.run(ALICE, "claim", { id: 2 });
	await h.click(POSTER, buttonIds(claim)[0]!);
	await h.run(POSTER, "cancel", { id: 3 });
	h.time.advance({ hours: 2 });
	await h.runExpiryJob();

	expect(h.totalMoney()).toBe(start);
	expect({
		poster: h.balance(POSTER),
		alice: h.balance(ALICE),
		bob: h.balance(BOB),
	}).toEqual({ poster: 70, alice: 10, bob: 20 });
});
