import * as Sentry from "@sentry/bun";

import {
	ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
	userMention,
	type Message,
	type OmitPartialGroupDMChannel,
} from "discord.js";
import { Feature } from "../utils/service";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";
import { traced, wrapInteractionDo } from "../utils/tracing";
import type { DatabaseService, Transaction } from "./database";
import { Tokenizr } from "tokenizr";
import { markov4 } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";

enum Tokens {
	Space = "space",
	Punctuation = "punctuation",
	Word = "word",
	Eof = "EOF",
}

export const commandSpec = new SlashCommandBuilder()
	.setName("imitate")
	.setDescription("Imitate a server member using the Markov model")
	.addStringOption((option) =>
		option
			.setName("prompt")
			.setDescription("Text to start the message with")
			.setRequired(false),
	)
	.addUserOption((option) =>
		option.setName("user").setDescription("User to imitate (optional)").setRequired(false),
	);

export class CannotExtrapolate extends Error {
	public prompt: string;

	constructor(prompt: string) {
		super(`cannot extrapolate from prompt "${prompt}"`);
		this.prompt = prompt;
	}
}

export class MarkovService extends Feature {
	#db: DatabaseService;
	#discord: DiscordService;
	#tokenizer: Tokenizr;

	constructor(env: EnvService, discord: DiscordService, db: DatabaseService) {
		super(env);
		this.#db = db;
		this.#discord = discord;
		this.#tokenizer = MarkovService.#createTokenizer();

		if (this.isEnabled()) {
			this.#discord.subscribe("message:create", (...args) =>
				this.#processMessageForTraining(...args),
			);
			// We don't need to handle message:delete events because the markov4 table has ON DELETE CASCADE.

			// Register the slash command. This will run asynchronously.
			this.#discord
				.registerSlashCommand(commandSpec, (interaction) =>
					this.#handleSlashCommand(interaction),
				)
				.then(() => Sentry.logger.info("MarkovService initialized"));
		} else {
			Sentry.logger.info("MarkovService disabled");
		}
	}

	static #createTokenizer(): Tokenizr {
		const t = new Tokenizr();
		t.rule(/\p{Separator}+/u, (ctx) => {
			ctx.accept(Tokens.Space);
		});
		t.rule(/[\p{Punctuation}\p{Symbol}]/u, (ctx) => {
			ctx.accept(Tokens.Punctuation);
		});
		t.rule(/[^\p{Punctuation}\p{Symbol}\p{Separator}]+/u, (ctx) => {
			ctx.accept(Tokens.Word);
		});
		return t;
	}

	/**
	 * Tokenizes a message.
	 * @param msgContent message content to tokenize
	 * @returns a stream of strings representing tokens
	 */
	*#tokenize(msgContent: string) {
		this.#tokenizer.input(msgContent);
		while (true) {
			const token = this.#tokenizer.token()!;
			if (token.type === Tokens.Eof) {
				return token.text;
			} else {
				yield token.text;
			}
		}
	}

	@traced("event.handler")
	async #processMessageForTraining(message: OmitPartialGroupDMChannel<Message>) {
		Sentry.getCurrentScope().setAttributes({
			"message.id": message.id,
			"user.id": message.author.id,
		});

		if (!message.inGuild()) {
			Sentry.logger.info("Skipping non-guild message");
			return;
		}

		if (message.author.bot) {
			Sentry.logger.info("Skipping bot message");
			return;
		}

		const prefix: (string | null)[] = [null, null, null, null];
		const tokens = this.#tokenize(message.content);
		await this.#db.query("insert markov entries", async (tx) => {
			for (const token of tokens) {
				await tx.insert(markov4).values({
					message_id: message.id,
					author_id: message.author.id,
					word1: prefix[0],
					word2: prefix[1],
					word3: prefix[2],
					word4: prefix[3],
					word5: token,
				});
				prefix.shift();
				prefix.push(token);
			}
			await tx.insert(markov4).values({
				message_id: message.id,
				author_id: message.author.id,
				word1: prefix[0],
				word2: prefix[1],
				word3: prefix[2],
				word4: prefix[3],
				word5: null,
			});
		});
		Sentry.logger.info("Added message to Markov model");
	}

	@traced("event.handler")
	async #handleSlashCommand(interaction: ChatInputCommandInteraction) {
		const target = interaction.options.getUser("user");
		const prompt = interaction.options.getString("prompt") ?? "";
		const metadata = {
			prompt,
			"target.user.id": target?.id,
			"user.id": interaction.user.id,
		};
		Sentry.getActiveSpan()?.setAttributes(metadata);
		try {
			const sentence = await this.#generateSentence(prompt, target?.id);
			if (sentence) {
				await wrapInteractionDo(
					interaction,
					"reply",
				)({
					content: sentence,
					allowedMentions: { parse: [] }, // silence mentions
				});
				Sentry.logger.info("Generated sentence", { sentence });
			} else {
				// Failed to generate sentence
				const targetMention = target ? `from ${userMention(target.id)}` : "";
				await wrapInteractionDo(
					interaction,
					"reply",
				)({
					content: `⚠️ Error: cannot extrapolate from "${prompt}".
No messages in the database were found ${targetMention} which start with the prompt.`,
					flags: [MessageFlags.Ephemeral],
				});
			}
		} catch (err) {
			Sentry.captureException(err, { extra: { metadata } });
			const message = err instanceof Error ? err.message : String(err);
			await (interaction.replied ? interaction.followUp : interaction.reply)({
				content: `⚠️ Error: ${message}`,
				flags: [MessageFlags.Ephemeral],
			});
		}
	}

	/**
	 * Generates a sentence using the Markov model.
	 * @param prompt prompt to start the sentence with
	 * @param authorId optional author ID to filter on
	 * @returns the generated sentence, or null if the given prompt could not be expanded
	 */
	async #generateSentence(prompt: string, authorId?: string): Promise<string | null> {
		const tokens = Array.from(this.#tokenize(prompt));
		let isFirstToken = true;
		await this.#db.query("extrapolate markov message", async (tx) => {
			while (true) {
				const token = await this.#getNextMarkovToken(
					tx,
					authorId,
					tokens.at(-4) ?? null,
					tokens.at(-3) ?? null,
					tokens.at(-2) ?? null,
					tokens.at(-1) ?? null,
				);
				if (token === null) break;
				isFirstToken = false;
				tokens.push(token);
				if (tokens.length > 1000) {
					throw new Error("runaway message");
				}
			}
		});
		if (isFirstToken) {
			return null;
		}
		return tokens.join("");
	}

	/**
	 * Queries the database for the next token according to the Markov model.
	 * @param tx database transaction
	 * @param authorId optional author ID to filter on
	 * @returns the predicted token if one exists, otherwise null
	 */
	async #getNextMarkovToken(
		tx: Transaction,
		authorId: string | undefined,
		word1: string | null,
		word2: string | null,
		word3: string | null,
		word4: string | null,
	): Promise<string | null> {
		const filter = and(
			sql`${markov4.word1} IS ${word1}`,
			sql`${markov4.word2} IS ${word2}`,
			sql`${markov4.word3} IS ${word3}`,
			sql`${markov4.word4} IS ${word4}`,
			authorId === undefined ? undefined : eq(markov4.author_id, authorId),
		);
		// Get number of possible next words
		const count = await tx.$count(markov4, filter);
		if (count == 0) return null;
		const offset = Math.floor(Math.random() * count);
		const result = await tx
			.select({ nextWord: markov4.word5 })
			.from(markov4)
			.where(filter)
			.limit(1)
			.offset(offset);
		return result[0]?.nextWord ?? null;
	}
}
