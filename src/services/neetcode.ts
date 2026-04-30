import * as Sentry from "@sentry/bun";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonInteraction,
	ButtonStyle,
	channelMention,
	ChannelType,
	DiscordjsError,
	DiscordjsErrorCodes,
	Message,
	MessageFlags,
	messageLink,
	MessageReaction,
	SlashCommandBuilder,
	SlashCommandIntegerOption,
	ThreadAutoArchiveDuration,
	User,
	userMention,
	type ChatInputCommandInteraction,
	type PartialMessageReaction,
	type PartialUser,
} from "discord.js";
import z from "zod";
import { SQLiteError } from "bun:sqlite";
import { eq, gte, asc, min, isNotNull, and, or, isNull, lt, sql, count, max } from "drizzle-orm";

import { announcements, problems as problemsTable, solves as solvesTable } from "../db/schema";
import { Feature } from "../utils/service";
import type { DatabaseService } from "./database";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";
import { wrapInteractionDo, traced, editMessage } from "../utils/tracing";
import { Channels, MAX_MSG_CONTENT_LENGTH, Users } from "../consts";
import { dateToSqlite, sqliteToDate } from "../utils/time";
import type { CronService } from "./cron";
import { ja } from "zod/v4/locales";

enum Subcommand {
	Set = "set",
	Clear = "clear",
	List = "list",
	Announce = "announce",
	Stats = "stats",
	FindUnsolved = "find-unsolved",
}

const NeetcodeAdmins = [Users.Kian, Users.Alex];
const SubcommandAllowedUsers: Record<Subcommand, Users[] | "*"> = {
	[Subcommand.Set]: NeetcodeAdmins,
	[Subcommand.Clear]: NeetcodeAdmins,
	[Subcommand.List]: NeetcodeAdmins,
	[Subcommand.Announce]: NeetcodeAdmins,
	[Subcommand.Stats]: "*",
	[Subcommand.FindUnsolved]: "*",
};

type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

const MAX_PROBLEMS = 5;
const daysFromTodayOptionFunc = (option: SlashCommandIntegerOption): SlashCommandIntegerOption =>
	option
		.setName("days-from-today")
		.setDescription(
			"Date to modify, as a number of days from today (0 = today, 1 = tomorrow, etc.). Default: tomorrow",
		)
		.setRequired(false);
const commandSpec = new SlashCommandBuilder()
	.setName("neetcode")
	.setDescription("Manage the Neetcode bot")
	.addSubcommand((sub) => {
		sub = sub.setName(Subcommand.Set).setDescription("Set a day's problems");
		for (let i = 1; i <= MAX_PROBLEMS; i++) {
			sub = sub.addStringOption((option) =>
				option
					.setName(`url-${i}`)
					.setDescription(`URL of Neetcode problem #${i}` + (i == 1 ? "" : " (optional)"))
					.setRequired(i == 1),
			);
		}
		return sub.addIntegerOption(daysFromTodayOptionFunc);
	})
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Clear)
			.setDescription("Clear the problems for the given day")
			.addIntegerOption(daysFromTodayOptionFunc),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.List)
			.setDescription("List each day's problems")
			.addBooleanOption((option) =>
				option
					.setName("include-past")
					.setDescription("Include days in the past. Default: false")
					.setRequired(false),
			),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Announce)
			.setDescription("Manually trigger announcement of today's problems"),
	)
	.addSubcommand((sub) =>
		sub
			.setName(Subcommand.Stats)
			.setDescription("Show a user's stats")
			.addUserOption((option) =>
				option
					.setName("user")
					.setDescription("The user to show stats for")
					.setRequired(false),
			)
			.addBooleanOption((option) =>
				option
					.setName("private")
					.setDescription("If true, only you can see the response. Default: false")
					.setRequired(false),
			),
	)
	.addSubcommand((sub) =>
		sub.setName(Subcommand.FindUnsolved).setDescription("Find problems you haven't solved yet"),
	);

class UniquenessError extends Error {
	constructor(message: string) {
		super(message);
	}
}

export class NeetcodeService extends Feature {
	#discord: DiscordService;
	#db: DatabaseService;
	#dateFormatter: Intl.DateTimeFormat;

	constructor(env: EnvService, discord: DiscordService, db: DatabaseService, cron: CronService) {
		super(env);
		this.#discord = discord;
		this.#db = db;

		this.#dateFormatter = new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "2-digit",
		});

		if (this.isEnabled()) {
			// Register slash commands
			this.#discord.registerSlashCommand(commandSpec, (interaction) =>
				this.#handleCommandInvocation(interaction),
			);
			// Register reaction handlers
			this.#discord.subscribe("reaction:create", (r, u) => this.#handleReactionAdd(r, u));
			this.#discord.subscribe("reaction:delete", (r, u) => this.#handleReactionRemove(r, u));
			// Create announcement job
			cron.createJob("neetcode.announce", "0 0 * * *", () => this.#sendAnnouncement());
			// Create warning job
			cron.createJob("neetcode.warn", "0 22 * * *", () => this.#checkForProblemsAndWarn());
			Sentry.logger.info(`${this._name} initialized`, {
				"service.name": this._name,
			});
		} else {
			Sentry.logger.info(`${this._name} disabled`, {
				"service.name": this._name,
			});
		}
	}

	@traced("event.handler")
	async #handleCommandInvocation(interaction: ChatInputCommandInteraction) {
		// Ensure we're in #neetcode or a DM
		const channelIsDMBased = async () => {
			return (
				interaction.channel?.isDMBased() ??
				(await interaction.client.channels.fetch(interaction.channelId))?.isDMBased() ??
				false
			);
		};
		if (interaction.channelId != Channels.Neetcode && !channelIsDMBased()) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `This command can only be used in ${channelMention(Channels.Neetcode)} or a DM.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const rawSubcommand = interaction.options.getSubcommand();
		const metadata = {
			"command.id": interaction.commandId,
			"command.name": interaction.commandName,
			"command.subcommand": rawSubcommand,
			"user.id": interaction.user.id,
			"user.name": interaction.user.displayName,
		};
		Sentry.getCurrentScope().setAttributes(metadata);
		Sentry.getActiveSpan()?.setAttributes(metadata);
		Sentry.setExtras(metadata);

		// Dispatch to the right subcommand handler
		const parse = z.enum(Subcommand).safeParse(rawSubcommand);
		if (!parse.success) {
			Sentry.logger.error(
				Sentry.logger.fmt`Invalid subcommand: ${z.prettifyError(parse.error)}`,
			);
			Sentry.captureException(parse.error);
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "Invalid subcommand. How did you even get here?",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		const subcommand = parse.data;

		// Check authorization
		const allowedUsers = SubcommandAllowedUsers[subcommand];
		if (allowedUsers !== "*" && !(allowedUsers as string[]).includes(interaction.user.id)) {
			Sentry.logger.info("Permission denied for command");
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "You are not French enough to use this command.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		Sentry.logger.info("Permission granted for command");

		const handlers: { [key in Subcommand]: CommandHandler } = {
			[Subcommand.Set]: this.#executeSet,
			[Subcommand.Clear]: this.#executeClear,
			[Subcommand.List]: this.#executeList,
			[Subcommand.Announce]: this.#executeAnnounce,
			[Subcommand.Stats]: this.#executeStats,
			[Subcommand.FindUnsolved]: this.#executeFindUnsolved,
		};
		await handlers[subcommand].apply(this, [interaction]).catch(async (error) => {
			const message = error instanceof Error ? error.message : String(error);
			Sentry.logger.error(Sentry.logger.fmt`Error executing command: ${message}`);
			Sentry.captureException(error);
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "⚠️ An error occurred while executing the command",
				flags: [MessageFlags.Ephemeral],
			});
		});
		Sentry.logger.info("Command finished successfully");
	}

	/**
	 * Returns time 00:00 on the date given by today plus the offset in days.
	 * E.g. getDate(1) is 00:00 tomorrow, and getDate(-1) is yesterday.
	 */
	#getDate(daysFromToday: number): Date {
		const DAY_IN_MS = 24 * 60 * 60 * 1000;
		const date = new Date(Date.now() + daysFromToday * DAY_IN_MS);
		date.setHours(0, 0, 0, 0);
		return date;
	}

	#formatProblemURLs(problemUrls: string[]): string {
		return problemUrls.map((url) => `- <${url}>`).join("\n");
	}

	async #getProblemsForDay(offsetFromToday: number): Promise<string[]> {
		const rows = await this.#db.query("select problems", (tx) =>
			tx
				.select({ url: problemsTable.url })
				.from(problemsTable)
				.where(eq(problemsTable.date, dateToSqlite(this.#getDate(offsetFromToday)))),
		);
		return rows.map((row) => row.url);
	}

	@traced("command.handler")
	async #executeSet(interaction: ChatInputCommandInteraction) {
		// Get problem list from command options
		const problems: string[] = [];
		for (let i = 1; i <= MAX_PROBLEMS; i++) {
			const url = interaction.options.getString(`url-${i}`, i == 1);
			if (!url) continue;
			problems.push(url.replace(/\?list=[^/]*$/, ""));
		}
		const daysFromToday = interaction.options.getInteger("days-from-today") ?? 1;

		const date = this.#getDate(daysFromToday);
		const dateString = date.toLocaleDateString("en-US", {
			month: "numeric",
			day: "2-digit",
		});

		const commitAndGetResponseContent = async () => {
			try {
				await this.#db.query("insert problems", async (tx) => {
					await tx
						.delete(problemsTable)
						.where(eq(problemsTable.date, dateToSqlite(date)));
					for (const url of problems) {
						try {
							await tx
								.insert(problemsTable)
								.values({ date: dateToSqlite(date), url });
						} catch (error) {
							if (
								error instanceof SQLiteError &&
								error.code == "SQLITE_CONSTRAINT_UNIQUE"
							) {
								throw new UniquenessError(`Problem ${url} is already in the list`);
							}
						}
					}
				});
			} catch (error) {
				if (error instanceof UniquenessError) {
					return `⚠️ Error: ${error.message}`;
				}
				throw error;
			}
			const formattedProblems = this.#formatProblemURLs(
				await this.#getProblemsForDay(daysFromToday),
			);
			return `Problems set for ${dateString}:\n${formattedProblems}`;
		};

		try {
			// If problems are already set, confirm before overwriting
			const currentProblems = await this.#getProblemsForDay(daysFromToday);
			if (currentProblems.length > 0) {
				await this.#promptForConfirmation({
					interaction,
					promptContent: `The following problems are already set for ${dateString}:
${this.#formatProblemURLs(currentProblems)}
Are you sure you want to overwrite them?`,
					onCancel: async (click) => {
						// If cancelled, update the initial response
						await (click instanceof Message ? click.edit : click?.update)?.({
							content: "Cancelled.",
							components: [],
						});
					},
					onConfirm: async (click) => {
						// If confirmed, commit the changes and update the initial response
						await click.update({
							content: await commitAndGetResponseContent(),
							components: [],
						});
					},
				});
			} else {
				// If not overwriting already-set problems, commit the changes and reply to the command
				await wrapInteractionDo(
					interaction,
					"reply",
				)({
					content: await commitAndGetResponseContent(),
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch (error) {
			Sentry.logger.error("Failed to set Neetcode problems");
			Sentry.captureException(error);
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "Failed to set problems.",
				flags: MessageFlags.Ephemeral,
			});
		}
	}

	@traced("command.handler")
	async #executeClear(interaction: ChatInputCommandInteraction) {
		const daysFromToday = interaction.options.getInteger("days-from-today") ?? 1;
		const date = this.#getDate(daysFromToday);
		const dateString = date.toLocaleDateString("en-US", {
			month: "numeric",
			day: "2-digit",
		});

		const problems = await this.#getProblemsForDay(daysFromToday);
		if (problems.length > 0) {
			// Confirm before clearing
			await this.#promptForConfirmation({
				interaction,
				promptContent: `This will clear the following problems for ${dateString}:
${this.#formatProblemURLs(problems)}
Continue?`,
				onCancel: async (click) => {
					await (click instanceof Message ? click.edit : click?.update)?.({
						content: "Canceled.",
						components: [],
					});
				},
				onConfirm: async (click) => {
					await this.#db.query("delete problems", (tx) =>
						tx
							.delete(problemsTable)
							.where(
								eq(problemsTable.date, dateToSqlite(this.#getDate(daysFromToday))),
							),
					);
					click.update({
						content: `Cleared ${problems.length} problems for ${dateString}`,
						components: [],
					});
					Sentry.logger.info(
						Sentry.logger.fmt`Cleared ${problems.length} problems for ${date}`,
					);
				},
			});
		} else {
			// No problems to clear
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `No problems to clear for ${dateString}`,
				flags: MessageFlags.Ephemeral,
			});
		}
	}

	/**
	 * Gets a list of the problems from the database grouped by date
	 * @param includePast if true, includes past problems
	 */
	async #listProblems(includePast: boolean): Promise<Map<Date, string[]>> {
		// Map using seconds since epoch as the keys, since Date objects don't equal each other
		const epochMap: Map<number, string[]> = new Map();
		const minDate = includePast ? new Date(0) : this.#getDate(0);
		const rows = await this.#db.query("select problems", (tx) =>
			tx
				.select()
				.from(problemsTable)
				.where(gte(problemsTable.date, dateToSqlite(minDate)))
				.orderBy(asc(problemsTable.date)),
		);
		for (const row of rows) {
			const entry = epochMap.get(row.date);
			if (entry) {
				entry.push(row.url);
			} else {
				epochMap.set(row.date, [row.url]);
			}
		}
		const dateMap: Map<Date, string[]> = new Map();
		for (const [epoch, urls] of epochMap) {
			dateMap.set(sqliteToDate(epoch), urls);
		}
		return dateMap;
	}

	@traced("command.handler")
	async #executeList(interaction: ChatInputCommandInteraction) {
		const includePast = interaction.options.getBoolean("include-past") ?? false;
		const days = await this.#listProblems(includePast);
		if (days.size === 0) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: "No problems found.",
				flags: MessageFlags.Ephemeral,
			});
		} else {
			let message = "";
			for (const [day, problems] of days) {
				const weekday = day.toLocaleDateString("en-US", {
					weekday: "long",
				});
				message += `### ${weekday}, ${day.getMonth() + 1}/${day.getDate()}\n`;
				message += this.#formatProblemURLs(problems);
				message += "\n";
			}
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: message.trim(),
				flags: MessageFlags.Ephemeral,
			});
		}
	}

	@traced("command.handler")
	async #executeAnnounce(interaction: ChatInputCommandInteraction) {
		// Tell Discord we're processing the command and will respond shortly
		await wrapInteractionDo(
			interaction,
			"deferReply",
		)({
			flags: MessageFlags.Ephemeral,
		});
		let responseMsg = "Announcement sent.";
		try {
			await this.#sendAnnouncement();
		} catch (error) {
			responseMsg = `Error sending announcement: ${(error as Error).message}.`;
		}
		// Finalize response
		await wrapInteractionDo(
			interaction,
			"editReply",
		)({
			content: responseMsg,
		});
	}

	async #getStats(
		user: User,
	): Promise<{ solves: number; firstSolves: number; longestStreak: number }> {
		return this.#db.query("select solve stats", async (tx) => {
			// Get number of solves
			const solves = await tx.$count(solvesTable, eq(solvesTable.user_id, user.id));

			// Get number of first solves
			const firstSolvesSubquery = tx
				.select({
					user_id: solvesTable.user_id,
					solve_time: min(solvesTable.solve_time),
				})
				.from(solvesTable)
				.where(isNotNull(solvesTable.solve_time))
				.groupBy(solvesTable.announcement_id)
				.as("first_solves");
			const firstSolves = await tx.$count(
				firstSolvesSubquery,
				eq(firstSolvesSubquery.user_id, user.id),
			);

			// Get longest streak
			const validSolvesCTE = tx.$with("valid_solves").as(
				tx
					.select({ date: announcements.date })
					.from(solvesTable)
					.innerJoin(
						announcements,
						eq(announcements.message_id, solvesTable.announcement_id),
					)
					.where(
						and(
							eq(solvesTable.user_id, user.id),
							or(
								isNull(solvesTable.solve_time),
								lt(sql`${solvesTable.solve_time} - ${announcements.date}`, 86400),
							),
						),
					),
			);
			const streakGroupsCTE = tx.$with("streak_groups").as(
				tx
					.select({
						date: validSolvesCTE.date,
						group: sql<number>`${validSolvesCTE.date} - (ROW_NUMBER() OVER (ORDER BY ${validSolvesCTE.date})) * 86400`.as(
							"group",
						),
					})
					.from(validSolvesCTE),
			);
			const streaksCTE = tx.$with("streaks").as(
				tx
					.select({ length: count().as("length") })
					.from(streakGroupsCTE)
					.groupBy(() => streakGroupsCTE.group),
			);
			const streakRows = await tx
				.with(validSolvesCTE, streakGroupsCTE, streaksCTE)
				.select({ length: max(streaksCTE.length) })
				.from(streaksCTE);
			const longestStreak = parseInt(streakRows[0].length ?? "0");

			return { solves, firstSolves, longestStreak };
		});
	}

	@traced("command.handler")
	async #executeStats(interaction: ChatInputCommandInteraction) {
		const user = interaction.options.getUser("user") ?? interaction.user;
		const isPrivate = interaction.options.getBoolean("private") ?? false;
		const stats = await this.#getStats(user);
		await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: `## Stats for ${user}
- ✅ Solves: ${stats.solves}
- 🥇 First solves: ${stats.firstSolves}
- 📆 Longest daily streak: ${stats.longestStreak}`,
			allowedMentions: { parse: ["users"] },
			flags: MessageFlags.SuppressNotifications | (isPrivate ? MessageFlags.Ephemeral : 0),
		});
	}

	@traced("command.handler")
	async #executeFindUnsolved(interaction: ChatInputCommandInteraction) {
		const user = interaction.user;
		const unsolvedAnnouncements = await this.#db.query(
			"select unsolved announcements",
			(tx) => {
				const userSolves = tx.$with("user_solves").as(
					tx
						.select({
							announcementId: solvesTable.announcement_id,
						})
						.from(solvesTable)
						.where(eq(solvesTable.user_id, user.id)),
				);
				return tx
					.with(userSolves)
					.select({
						messageId: announcements.message_id,
						date: announcements.date,
					})
					.from(announcements)
					.where(sql`${announcements.message_id} NOT IN ${userSolves}`);
			},
		);

		if (unsolvedAnnouncements.length === 0) {
			await wrapInteractionDo(
				interaction,
				"reply",
			)({
				content: `No unsolved problems. Nice work!`,
				flags: [MessageFlags.Ephemeral],
			});
			return;
		}

		const messageLinks = unsolvedAnnouncements.map((announcement) => {
			const link = messageLink(
				Channels.Neetcode,
				announcement.messageId,
				interaction.guildId!,
			);
			const date = sqliteToDate(announcement.date);
			const formattedDate = this.#dateFormatter.format(date);
			return `\n- ${formattedDate}: ${link}`;
		});
		const messages = [`Unsolved days for ${user}:`];

		for (const link of messageLinks) {
			const lastMsg = messages[messages.length - 1];
			if (lastMsg.length + link.length > MAX_MSG_CONTENT_LENGTH) {
				// Start a new message
				messages.push("");
			}
			messages[messages.length - 1] += link;
		}
		for (let i = 0; i < messages.length; i++) {
			await wrapInteractionDo(
				interaction,
				i === 0 ? "reply" : "followUp",
			)({
				content: messages[i],
				flags: MessageFlags.Ephemeral,
			});
		}
	}

	async #promptForConfirmation({
		interaction,
		promptContent,
		onConfirm,
		onCancel,
	}: {
		interaction: ChatInputCommandInteraction;
		promptContent: string;
		onConfirm: (click: ButtonInteraction) => Promise<void>;
		onCancel: (click: ButtonInteraction | Message | null) => Promise<void>;
	}) {
		// Send a response with a confirm and a cancel button
		const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId("cancel")
				.setLabel("Cancel")
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId("confirm")
				.setLabel("Confirm")
				.setStyle(ButtonStyle.Danger),
		);

		const response = await wrapInteractionDo(
			interaction,
			"reply",
		)({
			content: promptContent,
			flags: MessageFlags.Ephemeral,
			components: [buttonRow],
			withResponse: true,
		});

		// Wait for the button to be clicked
		try {
			const click = await Sentry.startSpan({ name: "wait for interaction" }, () =>
				response.resource?.message?.awaitMessageComponent({
					time: 60_000, // 1 minute
				}),
			);
			await Sentry.startSpan(
				{ name: "component interaction", op: "event.handler" },
				async () => {
					if (!click?.isButton()) {
						throw new Error("Unexpected interaction event received");
					}
					if (click.customId === "confirm") {
						await onConfirm(click);
					} else if (click.customId === "cancel") {
						await onCancel(click);
					} else {
						throw new Error(`Unexpected button click: id = ${click.customId}`);
					}
				},
			);
		} catch (err) {
			if (
				err instanceof DiscordjsError &&
				err.code === DiscordjsErrorCodes.InteractionCollectorError
			) {
				// Timed out while waiting
				onCancel(response.resource?.message ?? null);
			} else {
				throw err;
			}
		}
	}

	@traced()
	async #sendAnnouncement() {
		const problems = await this.#getProblemsForDay(0);

		// Ensure there are problems for today
		if (problems.length === 0) {
			Sentry.logger.warn("No Neetcode problems found for today");
			await this.#warnAboutNoProblems("today");
			return;
		}

		const channel = await this.#getChannel();

		// Post message
		const today = this.#getDate(0);
		const dateString = this.#dateFormatter.format(today);
		const message = await Sentry.startSpan(
			{ name: "discord.channel.send", op: "discord.send" },
			() =>
				channel.send({
					content: `# 📆 ${dateString}
## Today's NeetCode problems are:
${this.#formatProblemURLs(problems)}`,
				}),
		);
		// Pin message
		await Sentry.startSpan({ name: "discord.message.pin", op: "discord.send" }, () =>
			message.pin(),
		);

		// Create spoiler threads
		await Promise.all(
			problems.map(async (problem) => {
				const id = this.#extractProblemId(problem);
				await Sentry.startSpan(
					{
						name: "discord.channel.threads.create",
						op: "discord.send",
					},
					() =>
						channel.threads.create({
							name: `${dateString}: ${id} 🧵`,
							autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
							reason: `Spoiler thread for ${id}`,
						}),
				);
			}),
		);

		// Add to database
		await this.#db.query("insert announcement", (tx) =>
			tx.insert(announcements).values({
				message_id: message.id,
				date: dateToSqlite(today),
			}),
		);

		Sentry.logger.info("Neetcode announcement & threads posted");
	}

	#extractProblemId(url: string): string {
		return url.replace(
			/^(https?:\/\/)?(neetcode\.io|leetcode.com)\/problems\/(?<id>[^/?]+)\/?(\?list=.*)?$/,
			"$<id>",
		);
	}

	async #getChannel() {
		const channel = await this.#discord.client.channels.fetch(Channels.Neetcode);
		if (!channel) {
			throw new Error("Cannot find #neetcode channel");
		}
		if (channel.type !== ChannelType.GuildText) {
			throw new Error("#neetcode channel is not a text channel");
		}
		return channel;
	}

	async #checkForProblemsAndWarn() {
		const problems = this.#getProblemsForDay(1);
		if ((await problems).length === 0) {
			return this.#warnAboutNoProblems("tomorrow");
		}
	}

	@traced()
	async #warnAboutNoProblems(day: "today" | "tomorrow") {
		const channel = await this.#getChannel();
		await Sentry.startSpan({ name: "discord.channel.send", op: "discord.send" }, () =>
			channel.send({
				content: `${NeetcodeAdmins.map((u) => userMention(u)).join(" ")}
⚠️ **Warning:** there are no problems selected for ${day}`,
			}),
		);
		Sentry.logger.warn("Warning sent");
	}

	@traced("event.handler")
	async #handleReactionAdd(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	) {
		if (reaction.emoji.name !== "✅") return;
		if (!(await this.#isPastAnnouncement(reaction.message.id))) return;

		// Record solve
		const solveCount = await this.#db.query("insert solve", async (tx) => {
			await tx.insert(solvesTable).values({
				user_id: user.id,
				announcement_id: reaction.message.id,
				solve_time: dateToSqlite(new Date()),
			});
			return tx.$count(solvesTable, eq(solvesTable.announcement_id, reaction.message.id));
		});
		const isFirstSolve = solveCount === 1;

		if (isFirstSolve) {
			const message = await Sentry.startSpan(
				{ name: "discord.message.fetch", op: "discord.send" },
				() => reaction.message.fetch(),
			);
			await Sentry.startSpan({ name: "discord.message.edit", op: "discord.send" }, () =>
				message.edit({
					content: `${message.content}

🥇 First solve: ${user}`,
					allowedMentions: {
						parse: ["users"],
					},
				}),
			);
			Sentry.logger.info("First solve recorded");
		}

		Sentry.logger.info("Solve recorded");
	}

	@traced("event.handler")
	async #handleReactionRemove(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	) {
		if (reaction.emoji.name !== "✅") return;
		if (!(await this.#isPastAnnouncement(reaction.message.id))) return;

		const { deletedSolveTime, newFirstSolve } = await this.#db.query(
			"delete solve",
			async (tx) => {
				const deletedRows = await tx
					.delete(solvesTable)
					.where(
						and(
							eq(solvesTable.user_id, user.id),
							eq(solvesTable.announcement_id, reaction.message.id),
						),
					)
					.returning({ solveTime: solvesTable.solve_time });
				const deletedSolveTime = deletedRows[0]?.solveTime;
				const newFirstSolve = await tx.query.solves.findFirst({
					where: and(
						eq(solvesTable.announcement_id, reaction.message.id),
						isNotNull(solvesTable.solve_time),
					),
					orderBy: asc(solvesTable.solve_time),
				});
				return { deletedSolveTime, newFirstSolve };
			},
		);

		// If the solve was deleted and either there is no new first solve or it
		// has an older timestamp than the new first solve, update the first
		// solve message
		if (
			deletedSolveTime !== null &&
			(newFirstSolve === undefined || deletedSolveTime < (newFirstSolve?.solve_time ?? 0))
		) {
			const message = await Sentry.startSpan(
				{ name: "discord.message.fetch", op: "discord.send" },
				() => reaction.message.fetch(),
			);
			if (newFirstSolve !== undefined) {
				Sentry.logger.debug("Updating first solve");
				await editMessage(message, {
					content: message.content.replace(
						/First solve: .*$/,
						`First solve: ${userMention(newFirstSolve.user_id)}`,
					),
					allowedMentions: {
						parse: ["users"],
					},
				});
			} else {
				Sentry.logger.debug("Removing first solve");
				await editMessage(message, {
					content: message.content.replace(/\s*\n.* First solve: .*$/, ""),
				});
			}
		}

		Sentry.logger.info("Solve removed");
	}

	async #isPastAnnouncement(messageId: string): Promise<boolean> {
		const row = await this.#db.query("find announcement", (tx) =>
			tx.query.announcements.findFirst({
				where: eq(announcements.message_id, messageId),
			}),
		);
		return row !== undefined;
	}
}
