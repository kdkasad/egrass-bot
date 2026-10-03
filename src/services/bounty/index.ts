import * as Sentry from "@sentry/bun";
import {
	ActionRowBuilder,
	ApplicationIntegrationType,
	ButtonBuilder,
	ButtonStyle,
	ChatInputCommandInteraction,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
	type ButtonInteraction,
	type InteractionReplyOptions,
} from "discord.js";
import { and, asc, count, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import z from "zod";

import { Feature } from "../../utils/service";
import { traced, wrapInteractionDo } from "../../utils/tracing";
import {
	ClockTimeSource,
	dateToSqlite,
	parseDuration,
	sqliteToDate,
	type TimeSource,
} from "../../utils/time";
import { Channels, Users } from "../../consts";
import { bounties, bountyClaims, exchangeBalances, exchangeTransactions } from "../../db/schema";
import type { CronService } from "../cron";
import type { DatabaseService, Transaction } from "../database";
import type { DiscordService } from "../discord";
import type { EnvService } from "../env";
import {
	decideCancel,
	decideClaim,
	decideCreate,
	decideExpiry,
	decideVerification,
	MAX_TASK_LENGTH,
	LIST_PAGE_SIZE,
	paginate,
	type BountyState,
	type ClaimState,
	type Rejection,
} from "./logic";
import { ButtonLabels, CommandText, Messages, Reasons } from "./messages";

enum Subcommand {
	Create = "create",
	List = "list",
	Claim = "claim",
	Cancel = "cancel",
}

enum ButtonPrefix {
	Approve = "bounty/approve",
	Reject = "bounty/reject",
	ListPage = "bounty/list",
}

const MAX_PROOF_LENGTH = 500;

/** Users who can cancel anyone's bounty */
const BOUNTY_ADMINS: string[] = [Users.Kian, Users.Alex];

type BountyRow = typeof bounties.$inferSelect;
type ClaimRow = typeof bountyClaims.$inferSelect;

function toBountyState(row: BountyRow): BountyState {
	return {
		id: row.id,
		posterId: row.poster_id,
		task: row.task,
		amount: row.amount,
		requiresVerification: row.requires_verification,
		expiresAt: row.expires_at === null ? null : sqliteToDate(row.expires_at),
		status: row.status,
	};
}

function toClaimState(row: ClaimRow): ClaimState {
	return {
		id: row.id,
		bountyId: row.bounty_id,
		claimerId: row.claimer_id,
		status: row.status,
	};
}

function getBalance(tx: Transaction, userId: string): number {
	const row = tx
		.select({ balance: exchangeBalances.balance })
		.from(exchangeBalances)
		.where(eq(exchangeBalances.user_id, userId))
		.get();
	return row?.balance ?? 0;
}

function adjustBalance(tx: Transaction, userId: string, delta: number) {
	tx.insert(exchangeBalances)
		.values({ user_id: userId, balance: delta })
		.onConflictDoUpdate({
			target: exchangeBalances.user_id,
			set: { balance: sql`${exchangeBalances.balance} + ${delta}` },
		})
		.run();
}

function getBounty(tx: Transaction, bountyId: number): BountyState | undefined {
	const row = tx.select().from(bounties).where(eq(bounties.id, bountyId)).get();
	return row && toBountyState(row);
}

function getPendingClaims(tx: Transaction, bountyId: number): ClaimState[] {
	return tx
		.select()
		.from(bountyClaims)
		.where(and(eq(bountyClaims.bounty_id, bountyId), eq(bountyClaims.status, "pending")))
		.all()
		.map(toClaimState);
}

/** Pays a bounty to a claimer and closes it. Must run inside a transaction. */
function payOut(tx: Transaction, bounty: BountyState, claim: ClaimState, now: Date) {
	adjustBalance(tx, claim.claimerId, bounty.amount);
	const transaction = tx
		.insert(exchangeTransactions)
		.values({
			sender_id: bounty.posterId,
			recipient_id: claim.claimerId,
			amount: bounty.amount,
			timestamp: dateToSqlite(now),
			memo: `Bounty #${bounty.id}: ${bounty.task}`,
			message_id: null,
		})
		.returning({ id: exchangeTransactions.id })
		.get();
	tx.update(bounties)
		.set({
			status: "completed",
			winner_id: claim.claimerId,
			closed_at: dateToSqlite(now),
			transaction_id: transaction.id,
		})
		.where(eq(bounties.id, bounty.id))
		.run();
	tx.update(bountyClaims)
		.set({ status: "approved", resolved_at: dateToSqlite(now) })
		.where(eq(bountyClaims.id, claim.id))
		.run();
}

export class BountyService extends Feature {
	static #command = new SlashCommandBuilder()
		.setName("bounty")
		.setDescription(CommandText.command)
		.setContexts(InteractionContextType.Guild)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.Create)
				.setDescription(CommandText.create)
				.addStringOption((opt) =>
					opt
						.setName("task")
						.setRequired(true)
						.setMaxLength(MAX_TASK_LENGTH)
						.setDescription(CommandText.createTask),
				)
				.addIntegerOption((opt) =>
					opt
						.setName("amount")
						.setRequired(true)
						.setMinValue(1)
						.setDescription(CommandText.createAmount),
				)
				.addStringOption((opt) =>
					opt
						.setName("time_limit")
						.setRequired(false)
						.setDescription(CommandText.createTimeLimit),
				)
				.addBooleanOption((opt) =>
					opt
						.setName("verification")
						.setRequired(false)
						.setDescription(CommandText.createVerification),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.List)
				.setDescription(CommandText.list)
				.addUserOption((opt) =>
					opt.setName("user").setRequired(false).setDescription(CommandText.listUser),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.Claim)
				.setDescription(CommandText.claim)
				.addIntegerOption((opt) =>
					opt
						.setName("id")
						.setRequired(true)
						.setMinValue(1)
						.setDescription(CommandText.claimId),
				)
				.addStringOption((opt) =>
					opt
						.setName("proof")
						.setRequired(false)
						.setMaxLength(MAX_PROOF_LENGTH)
						.setDescription(CommandText.claimProof),
				)
				.addAttachmentOption((opt) =>
					opt
						.setName("image")
						.setRequired(false)
						.setDescription(CommandText.claimProofImage),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.Cancel)
				.setDescription(CommandText.cancel)
				.addIntegerOption((opt) =>
					opt
						.setName("id")
						.setRequired(true)
						.setMinValue(1)
						.setDescription(CommandText.cancelId),
				),
		);

	#discord: DiscordService;
	#db: DatabaseService;
	#time: TimeSource;

	constructor(
		env: EnvService,
		discord: DiscordService,
		db: DatabaseService,
		cron: CronService,
		timeSource: TimeSource = new ClockTimeSource(),
	) {
		super(env);
		this.#discord = discord;
		this.#db = db;
		this.#time = timeSource;

		if (this.isEnabled()) {
			this.#discord.registerSlashCommand(BountyService.#command, (i) =>
				this.#handleCommand(i),
			);
			this.#discord.registerButtonHandler(ButtonPrefix.Approve, (i) =>
				this.#handleVerifyButton(i, true),
			);
			this.#discord.registerButtonHandler(ButtonPrefix.Reject, (i) =>
				this.#handleVerifyButton(i, false),
			);
			this.#discord.registerButtonHandler(ButtonPrefix.ListPage, (i) =>
				this.#handleListPageButton(i),
			);
			cron.createJob("expire bounties", "* * * * *", () => this.#expireBounties());
			Sentry.logger.info(Sentry.logger.fmt`${this._name} initialized`);
		} else {
			Sentry.logger.info(Sentry.logger.fmt`${this._name} disabled`);
		}
	}

	/** Replies privately, or follows up if the interaction was already answered */
	async #replyEphemeral(
		interaction: ChatInputCommandInteraction | ButtonInteraction,
		content: string,
	) {
		const method = interaction.replied || interaction.deferred ? "followUp" : "reply";
		await wrapInteractionDo(interaction, method)({ content, flags: [MessageFlags.Ephemeral] });
	}

	async #replyRejection(
		interaction: ChatInputCommandInteraction | ButtonInteraction,
		rejection: Rejection,
	) {
		await this.#replyEphemeral(interaction, Messages.rejection(rejection.reason));
	}

	@traced("event.handler")
	async #handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		const parseResult = z.enum(Subcommand).safeParse(interaction.options.getSubcommand());
		if (!parseResult.success) {
			await this.#replyEphemeral(interaction, Messages.error("unrecognized subcommand"));
			return;
		}
		const subcommand = parseResult.data;
		Sentry.getActiveSpan()?.setAttributes({ "discord.command.subcommand": subcommand });

		const dispatcher: Record<
			Subcommand,
			(interaction: ChatInputCommandInteraction) => Promise<void>
		> = {
			[Subcommand.Create]: this.#handleCreate,
			[Subcommand.List]: this.#handleList,
			[Subcommand.Claim]: this.#handleClaim,
			[Subcommand.Cancel]: this.#handleCancel,
		};
		try {
			await dispatcher[subcommand].call(this, interaction);
		} catch (err) {
			Sentry.captureException(err);
			await this.#replyEphemeral(
				interaction,
				Messages.error(err instanceof Error ? err.message : String(err)),
			);
		}
	}

	@traced("event.handler")
	async #handleCreate(interaction: ChatInputCommandInteraction) {
		const poster = interaction.user;
		const amount = interaction.options.getInteger("amount", true);
		const timeLimit = interaction.options.getString("time_limit");
		const requiresVerification = interaction.options.getBoolean("verification") ?? false;
		const now = this.#time.now();

		const result = this.#db.querySync("create bounty", (tx) => {
			const action = decideCreate({
				task: interaction.options.getString("task", true),
				amount,
				posterBalance: getBalance(tx, poster.id),
				timeLimitMs: timeLimit === null ? null : parseDuration(timeLimit),
				now,
			});
			if (action.do === "reject") return action;

			// Hold the bounty amount in escrow
			adjustBalance(tx, poster.id, -amount);
			const row = tx
				.insert(bounties)
				.values({
					poster_id: poster.id,
					task: action.task,
					amount,
					requires_verification: requiresVerification,
					created_at: dateToSqlite(now),
					expires_at: action.expiresAt === null ? null : dateToSqlite(action.expiresAt),
				})
				.returning()
				.get();
			return { do: "created" as const, bounty: toBountyState(row) };
		});

		if (result.do === "reject") {
			await this.#replyRejection(interaction, result);
			return;
		}
		const { bounty } = result;
		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: Messages.posted(bounty),
			allowedMentions: { users: [] },
		});
	}

	@traced("event.handler")
	async #handleList(interaction: ChatInputCommandInteraction) {
		const posterId = interaction.options.getUser("user")?.id ?? null;
		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			...this.#renderListPage(posterId, 0),
			flags: [MessageFlags.Ephemeral],
		});
	}

	@traced("event.handler")
	async #handleListPageButton(interaction: ButtonInteraction) {
		try {
			// Custom ID format: bounty/list:<page>:<posterId or empty>
			const [, page, posterId] = interaction.customId.split(":");
			// FIXME: wrap this with a Sentry span in DiscordService
			await interaction.update(
				this.#renderListPage(posterId || null, z.coerce.number().int().parse(page)),
			);
		} catch (err) {
			Sentry.captureException(err);
			await this.#replyEphemeral(
				interaction,
				Messages.error(err instanceof Error ? err.message : String(err)),
			);
		}
	}

	/** Renders one page of open bounties, optionally only those by `posterId` */
	#renderListPage(
		posterId: string | null,
		requestedPage: number,
	): Pick<InteractionReplyOptions, "content" | "components" | "allowedMentions"> {
		const filter = and(
			eq(bounties.status, "open"),
			posterId === null ? undefined : eq(bounties.poster_id, posterId),
		);
		const { rows, total, page, pageCount } = this.#db.querySync("list bounties", (tx) => {
			const total = tx.select({ n: count() }).from(bounties).where(filter).get()!.n;
			const { page, pageCount, offset } = paginate(total, requestedPage);
			const rows = tx
				.select()
				.from(bounties)
				.where(filter)
				.orderBy(asc(bounties.id))
				.limit(LIST_PAGE_SIZE)
				.offset(offset)
				.all();
			return { rows, total, page, pageCount };
		});

		const content = Messages.list(
			rows.map(toBountyState),
			posterId,
			{ page: page + 1, pageCount, total },
			this.#time.now(),
		);
		const components =
			pageCount === 1
				? []
				: [
						new ActionRowBuilder<ButtonBuilder>().setComponents(
							new ButtonBuilder()
								.setCustomId(
									`${ButtonPrefix.ListPage}:${page - 1}:${posterId ?? ""}`,
								)
								.setLabel(ButtonLabels.previous)
								.setStyle(ButtonStyle.Secondary)
								.setDisabled(page === 0),
							new ButtonBuilder()
								.setCustomId(
									`${ButtonPrefix.ListPage}:${page + 1}:${posterId ?? ""}`,
								)
								.setLabel(ButtonLabels.next)
								.setStyle(ButtonStyle.Secondary)
								.setDisabled(page === pageCount - 1),
						),
					];
		return {
			content,
			components,
			allowedMentions: { users: [] },
		};
	}

	@traced("event.handler")
	async #handleClaim(interaction: ChatInputCommandInteraction) {
		const bountyId = interaction.options.getInteger("id", true);
		const proof = interaction.options.getString("proof");
		const proofImage = interaction.options.getAttachment("image");
		const claimer = interaction.user;
		const now = this.#time.now();

		const result = this.#db.querySync("claim bounty", (tx) => {
			const bounty = getBounty(tx, bountyId);
			if (!bounty) {
				return { do: "reject", reason: Reasons.noSuchBounty(bountyId) } as Rejection;
			}
			const action = decideClaim({
				bounty,
				claimerId: claimer.id,
				claimerIsBot: claimer.bot,
				pendingClaims: getPendingClaims(tx, bountyId),
				proofImage,
				now,
			});
			if (action.do === "reject") return action;

			const claim = toClaimState(
				tx
					.insert(bountyClaims)
					.values({
						bounty_id: bountyId,
						claimer_id: claimer.id,
						proof,
						created_at: dateToSqlite(now),
					})
					.returning()
					.get(),
			);
			if (action.do === "payout") payOut(tx, bounty, claim, now);
			return { do: action.do, bounty, claim };
		});

		if (result.do === "reject") {
			await this.#replyRejection(interaction, result);
			return;
		}
		const { bounty, claim } = result;
		// Re-upload the image rather than linking it, since attachment URLs expire
		const files = proofImage ? [{ attachment: proofImage.url, name: proofImage.name }] : [];
		if (result.do === "payout") {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: Messages.instantPayout(bounty, claimer.id),
				allowedMentions: { users: [bounty.posterId] },
				files,
			});
			return;
		}

		const buttons = new ActionRowBuilder<ButtonBuilder>().setComponents(
			new ButtonBuilder()
				.setCustomId(`${ButtonPrefix.Approve}:${claim.id}`)
				.setLabel(ButtonLabels.approve(bounty.amount))
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId(`${ButtonPrefix.Reject}:${claim.id}`)
				.setLabel(ButtonLabels.reject)
				.setStyle(ButtonStyle.Danger),
		);
		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: Messages.verificationRequest(bounty, claimer.id, proof),
			components: [buttons],
			allowedMentions: { users: [bounty.posterId] },
			files,
		});
	}

	@traced("event.handler")
	async #handleVerifyButton(interaction: ButtonInteraction, approve: boolean) {
		try {
			const claimId = z.coerce.number().int().parse(interaction.customId.split(":")[1]);
			const now = this.#time.now();

			const result = this.#db.querySync("verify bounty claim", (tx) => {
				const claimRow = tx
					.select()
					.from(bountyClaims)
					.where(eq(bountyClaims.id, claimId))
					.get();
				const bounty = claimRow && getBounty(tx, claimRow.bounty_id);
				if (!claimRow || !bounty) {
					return { do: "reject", reason: Reasons.claimMissing } as Rejection;
				}
				const claim = toClaimState(claimRow);
				const action = decideVerification({
					bounty,
					claim,
					pendingClaims: getPendingClaims(tx, bounty.id),
					actorId: interaction.user.id,
					approve,
				});
				if (action.do === "reject") return action;

				if (action.do === "payout") {
					payOut(tx, bounty, claim, now);
					if (action.voidClaimIds.length > 0) {
						tx.update(bountyClaims)
							.set({ status: "voided", resolved_at: dateToSqlite(now) })
							.where(inArray(bountyClaims.id, action.voidClaimIds))
							.run();
					}
				} else {
					tx.update(bountyClaims)
						.set({ status: "rejected", resolved_at: dateToSqlite(now) })
						.where(eq(bountyClaims.id, claim.id))
						.run();
				}
				return { do: action.do, bounty, claim };
			});

			if (result.do === "reject") {
				await this.#replyRejection(interaction, result);
				return;
			}
			const { bounty, claim } = result;
			const verdict =
				result.do === "payout"
					? Messages.verdictApproved(bounty, claim.claimerId)
					: Messages.verdictRejected(bounty);
			// FIXME: wrap this with a Sentry span in DiscordService
			await interaction.update({
				content: `${interaction.message.content}\n\n${verdict}`,
				components: [],
				allowedMentions: { users: [] },
			});
			await interaction.followUp({
				content:
					result.do === "payout"
						? Messages.claimApproved(bounty, claim.claimerId)
						: Messages.claimRejected(bounty, claim.claimerId),
				allowedMentions: { users: [claim.claimerId] },
			});
		} catch (err) {
			Sentry.captureException(err);
			await this.#replyEphemeral(
				interaction,
				Messages.error(err instanceof Error ? err.message : String(err)),
			);
		}
	}

	@traced("event.handler")
	async #handleCancel(interaction: ChatInputCommandInteraction) {
		const bountyId = interaction.options.getInteger("id", true);
		const now = this.#time.now();

		const result = this.#db.querySync("cancel bounty", (tx) => {
			const bounty = getBounty(tx, bountyId);
			if (!bounty) {
				return { do: "reject", reason: Reasons.noSuchBounty(bountyId) } as Rejection;
			}
			const action = decideCancel({
				bounty,
				pendingClaims: getPendingClaims(tx, bountyId),
				actorId: interaction.user.id,
				actorIsAdmin: BOUNTY_ADMINS.includes(interaction.user.id),
			});
			if (action.do === "reject") return action;

			tx.update(bounties)
				.set({ status: "cancelled", closed_at: dateToSqlite(now) })
				.where(eq(bounties.id, bountyId))
				.run();
			if (action.voidClaimIds.length > 0) {
				tx.update(bountyClaims)
					.set({ status: "voided", resolved_at: dateToSqlite(now) })
					.where(inArray(bountyClaims.id, action.voidClaimIds))
					.run();
			}
			adjustBalance(tx, bounty.posterId, bounty.amount);
			return { do: "cancelled" as const, bounty };
		});

		if (result.do === "reject") {
			await this.#replyRejection(interaction, result);
			return;
		}
		const { bounty } = result;
		const byAdmin = interaction.user.id !== bounty.posterId;
		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: byAdmin
				? Messages.cancelledByAdmin(bounty, interaction.user.id)
				: Messages.cancelled(bounty),
			// Let the poster know when someone else cancelled their bounty
			allowedMentions: { users: byAdmin ? [bounty.posterId] : [] },
		});
	}

	@traced()
	async #expireBounties() {
		const now = this.#time.now();
		const expired = this.#db.querySync("expire bounties", (tx) => {
			const due = tx
				.select()
				.from(bounties)
				.where(
					and(
						eq(bounties.status, "open"),
						isNotNull(bounties.expires_at),
						lte(bounties.expires_at, dateToSqlite(now)),
					),
				)
				.all()
				.map(toBountyState);
			const result: BountyState[] = [];
			for (const bounty of due) {
				const action = decideExpiry({
					bounty,
					pendingClaims: getPendingClaims(tx, bounty.id),
					now,
				});
				if (action.do !== "expire") continue;
				tx.update(bounties)
					.set({ status: "expired", closed_at: dateToSqlite(now) })
					.where(eq(bounties.id, bounty.id))
					.run();
				adjustBalance(tx, bounty.posterId, bounty.amount);
				result.push(bounty);
			}
			return result;
		});

		// Refunds are already committed; failing to notify should not undo them
		for (const bounty of expired) {
			Sentry.logger.info("Bounty expired", {
				"bounty.id": bounty.id,
				"bounty.amount": bounty.amount,
				"discord.user.id": bounty.posterId,
			});
			try {
				if (!Channels.Wordle) throw new Error("Channels.Wordle is not set");
				await this.#discord.sendMessage(Channels.Wordle, {
					content: Messages.expired(bounty),
					allowedMentions: { users: [bounty.posterId] },
				});
			} catch (err) {
				Sentry.captureException(err);
				Sentry.logger.error(
					Sentry.logger
						.fmt`Failed to send expiry notice for bounty ${bounty.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
}
