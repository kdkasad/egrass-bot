import * as Sentry from "@sentry/bun";
import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
	userMention,
	type OmitPartialGroupDMChannel,
	type Message,
} from "discord.js";
import { count, eq, sql } from "drizzle-orm";
import z from "zod";

import { Feature } from "../utils/service";
import { traced, wrapInteractionDo } from "../utils/tracing";
import type { DatabaseService } from "./database";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";
import type { TrackingService } from "./tracking";
import {
	exchangeBalances,
	exchangeTransactions,
	members as membersTable,
	messages,
} from "../db/schema";

export class InsufficientBalanceError extends Error {
	need: number;
	have: number;
	constructor(need: number, have: number) {
		const difference = need - have;
		super(`Insufficient balance: need $${need}, have $${have} (short $${difference})`);
		this.need = need;
		this.have = have;
		this.name = "InsufficientBalanceError";
	}
}

enum Subcommand {
	Transfer = "transfer",
	Balance = "balance",
}

export class ExchangeService extends Feature {
	static #commandSpec = new SlashCommandBuilder()
		.setName("exchange")
		.setDescription("Interact with the Egrass Exchange")
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.Transfer)
				.setDescription("Transfer money to another user")
				.addUserOption((opt) =>
					opt
						.setName("recipient")
						.setRequired(true)
						.setDescription("The user to transfer money to"),
				)
				.addIntegerOption((opt) =>
					opt
						.setName("amount")
						.setRequired(true)
						.setMinValue(1)
						.setDescription("Amount of money ($) to transfer"),
				)
				.addStringOption((opt) =>
					opt.setName("memo").setRequired(true).setDescription("Description/reason"),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName(Subcommand.Balance)
				.setDescription("Check account balance")
				.addUserOption((opt) =>
					opt
						.setName("user")
						.setRequired(false)
						.setDescription("The user to check the balance of (defaults to you)"),
				),
		);

	#discord: DiscordService;
	#db: DatabaseService;
	#tracking: TrackingService;

	constructor(
		env: EnvService,
		discord: DiscordService,
		db: DatabaseService,
		tracking: TrackingService,
	) {
		super(env);
		this.#discord = discord;
		this.#db = db;
		this.#tracking = tracking;

		if (this.isEnabled()) {
			this.#discord.registerSlashCommand(ExchangeService.#commandSpec, (i) =>
				this.handleCommand(i),
			);
			this.#discord.subscribe("message:create", (msg) => this.handleMessageCreate(msg));
			this.init().catch((err) => {
				Sentry.captureException(err);
				Sentry.logger.error(
					Sentry.logger
						.fmt`Failed to run ExchangeService initialization: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
			Sentry.logger.info(Sentry.logger.fmt`${this._name} initialized`);
		} else {
			Sentry.logger.info(Sentry.logger.fmt`${this._name} disabled`);
		}
	}

	@traced()
	private async init() {
		try {
			// Wait for the startup guild member scan to complete in TrackingService
			await this.#tracking.waitUntilMemberScanDone();

			// One-time retroactive seeding on very first run
			const transactionCount = await this.#db.query("count transactions", (tx) =>
				tx.$count(exchangeTransactions),
			);
			if (transactionCount === 0) {
				await this.awardRetroactiveMessageIncome();
			}
		} catch (error) {
			Sentry.captureException(error);
			Sentry.logger.error(
				Sentry.logger
					.fmt`Error during ExchangeService initialization: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** @requires both exchangeTransactions and exchangeBalances tables must be empty */
	@traced()
	private async awardRetroactiveMessageIncome() {
		Sentry.logger.info("Starting retroactive historical message seeding...");

		const sqlNull = sql<null>`NULL`;
		await this.#db.query("retroactive seeding transaction", async (tx) => {
			// 1. Insert message rewards as transactions (joined with members to enforce FK constraint and exclude bots)
			await tx.insert(exchangeTransactions).select(
				tx
					.select({
						id: sqlNull.as("id"),
						sender_id: sqlNull.as("sender_id"),
						recipient_id: messages.author_id,
						amount: count().as("amount"),
						timestamp: sql<number>`unixepoch()`.as("timestamp"),
						memo: sql<string>`${"Retroactive historical message income"}`.as("memo"),
						message_id: sqlNull.as("message_id"),
					})
					.from(messages)
					// inner join is to only select messages from existing members
					.innerJoin(membersTable, eq(messages.author_id, membersTable.id))
					.where(eq(membersTable.is_bot, false))
					.groupBy(messages.author_id),
			);

			// 2. Insert transactions as balances
			await tx.insert(exchangeBalances).select(
				tx
					.select({
						user_id: exchangeTransactions.recipient_id,
						balance: exchangeTransactions.amount,
					})
					.from(exchangeTransactions),
			);
		});

		Sentry.logger.info("Retroactive historical message seeding complete");
	}

	@traced("event.handler")
	private async handleMessageCreate(message: OmitPartialGroupDMChannel<Message>) {
		if (!message.inGuild()) return;
		if (message.author.bot) return;
		await this.awardMessageIncome(message.author.id, message.id);
	}

	/**
	 * Awards message income to a user.
	 *
	 * FUTURE EXTENSION NOTE (Database Optimization):
	 * If the number of real-time transactions causes database bloat, we could aggregate
	 * system-generated income transactions. E.g., we could run a cron job at 00:01 UTC
	 * that runs an `INSERT INTO exchange_transactions SELECT ...` to coalesce all individual
	 * `$1` entries for the previous day into a single coalesced record (summing the amounts)
	 * and deletes the source rows.
	 */
	@traced()
	private async awardMessageIncome(userId: string, messageId: string) {
		await this.#db.query("award message income", async (tx) => {
			// Add $1 to balance
			await tx
				.insert(exchangeBalances)
				.values({
					user_id: userId,
					balance: 1,
				})
				.onConflictDoUpdate({
					target: exchangeBalances.user_id,
					set: { balance: sql`${exchangeBalances.balance} + 1` },
				});

			// Insert transaction log
			await tx.insert(exchangeTransactions).values({
				sender_id: null,
				recipient_id: userId,
				amount: 1,
				timestamp: Math.floor(Date.now() / 1000),
				memo: "Message reward",
				message_id: messageId,
			});
		});
	}

	/**
	 * @returns the ID of the newly-created transaction
	 */
	@traced()
	private async transferFunds(
		senderId: string,
		recipientId: string,
		amount: number,
		memo: string,
	): Promise<number> {
		return this.#db.query("transfer funds", async (tx) => {
			// 1. Get sender balance
			const senderRow = await tx
				.select({ balance: exchangeBalances.balance })
				.from(exchangeBalances)
				.where(eq(exchangeBalances.user_id, senderId));

			const senderBalance = senderRow[0]?.balance ?? 0;
			if (senderBalance < amount) {
				throw new InsufficientBalanceError(amount, senderBalance);
			}

			// 2. Deduct from sender
			await tx
				.update(exchangeBalances)
				.set({ balance: senderBalance - amount })
				.where(eq(exchangeBalances.user_id, senderId));

			// 3. Add to recipient
			await tx
				.insert(exchangeBalances)
				.values({
					user_id: recipientId,
					balance: amount,
				})
				.onConflictDoUpdate({
					target: exchangeBalances.user_id,
					set: { balance: sql`${exchangeBalances.balance} + ${amount}` },
				});

			// 4. Insert transaction with temporary null message_id
			const result = await tx
				.insert(exchangeTransactions)
				.values({
					sender_id: senderId,
					recipient_id: recipientId,
					amount: amount,
					timestamp: Math.floor(Date.now() / 1000),
					memo: memo,
					message_id: null,
				})
				.returning({ id: exchangeTransactions.id });

			const transactionId = result[0]?.id;
			if (transactionId === undefined) {
				throw new Error("Failed to retrieve transaction ID");
			}
			return transactionId;
		});
	}

	@traced()
	private async updateTransactionMessageId(transactionId: number, messageId: string) {
		await this.#db.query("update transaction message_id", async (tx) => {
			await tx
				.update(exchangeTransactions)
				.set({ message_id: messageId })
				.where(eq(exchangeTransactions.id, transactionId));
		});
	}

	@traced("event.handler")
	private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		const parseResult = z.enum(Subcommand).safeParse(interaction.options.getSubcommand());
		if (!parseResult.success) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "⚠️ Error: unrecognized subcommand",
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}
		const subcommand = parseResult.data;
		Sentry.getActiveSpan()?.setAttributes({
			"discord.command.subcommand": subcommand,
		});

		const subcommandDispatcher: Record<
			Subcommand,
			(interaction: ChatInputCommandInteraction) => Promise<void>
		> = {
			[Subcommand.Transfer]: this.handleTransfer,
			[Subcommand.Balance]: this.handleBalance,
		};

		const handler = subcommandDispatcher[subcommand];
		try {
			await handler.call(this, interaction);
		} catch (err) {
			Sentry.captureException(err);
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`,
				flags: [MessageFlags.Ephemeral],
			});
		}
	}

	@traced("event.handler")
	private async handleBalance(interaction: ChatInputCommandInteraction) {
		const targetUser = interaction.options.getUser("user") ?? interaction.user;

		if (targetUser.bot) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "🤖 Bots do not participate in the exchange and have no balance.",
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}

		const balanceRow = await this.#db.query("get balance", (tx) =>
			tx
				.select({ balance: exchangeBalances.balance })
				.from(exchangeBalances)
				.where(eq(exchangeBalances.user_id, targetUser.id)),
		);

		const balance = balanceRow[0]?.balance ?? 0;
		const isSelf = targetUser.id === interaction.user.id;
		const responseText = isSelf
			? `💰 Your current balance is **$${balance}**.`
			: `💰 ${userMention(targetUser.id)}'s current balance is **$${balance}**.`;

		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: responseText,
			flags: [MessageFlags.Ephemeral],
		});
	}

	@traced("event.handler")
	private async handleTransfer(interaction: ChatInputCommandInteraction) {
		const recipient = interaction.options.getUser("recipient", true);
		const amount = interaction.options.getInteger("amount", true);
		const memo = interaction.options.getString("memo", true);
		const sender = interaction.user;

		// Validation checks
		let error: string | null = null;
		if (recipient.bot) {
			error = "You cannot transfer money to a bot.";
		} else if (sender.id === recipient.id) {
			error = "You cannot transfer money to yourself.";
		} else if (amount <= 0) {
			error = "Transfer amount must be positive.";
		}
		if (error !== null) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `⚠️ Error: ${error}`,
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}

		try {
			// Perform transfer logic
			const transactionId = await this.transferFunds(sender.id, recipient.id, amount, memo);

			// Send transfer confirmation reply
			const reply = await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `💸 ${userMention(sender.id)} transferred **$${amount}** to ${userMention(recipient.id)}\n> *${memo}*`,
				withResponse: true,
			});

			// Update transaction with final confirmation message ID
			const confirmationMessageId = reply.resource?.message?.id;
			if (confirmationMessageId === undefined) {
				throw new Error(
					"Expected confirmation message ID to be present since reply succeeded",
				);
			}
			await this.updateTransactionMessageId(transactionId, confirmationMessageId);
		} catch (error) {
			if (error instanceof InsufficientBalanceError) {
				await wrapInteractionDo(
					interaction,
					"reply",
				)({
					content: `🚫 ${error.message}`,
					flags: [MessageFlags.Ephemeral],
				});
			} else {
				Sentry.captureException(error);
				const errorMessage = error instanceof Error ? error.message : String(error);

				await wrapInteractionDo(
					interaction,
					"reply",
				)({
					content: `⚠️ Error: ${errorMessage}`,
					flags: [MessageFlags.Ephemeral],
				});
			}
		}
	}
}
