import * as Sentry from "@sentry/bun";

import {
	ApplicationCommandType,
	ChatInputCommandInteraction,
	ContextMenuCommandBuilder,
	MessageContextMenuCommandInteraction,
	MessageFlags,
	messageLink,
	MessagePayload,
	SlashCommandBuilder,
	userMention,
	type InteractionEditReplyOptions,
	type InteractionReplyOptions,
	type Message,
	type OmitPartialGroupDMChannel,
} from "discord.js";
import { Feature } from "../utils/service";
import type { DiscordService } from "./discord";
import type { EnvService } from "./env";
import { traced, wrapInteractionDo } from "../utils/tracing";
import type { DatabaseService, Transaction } from "./database";
import { Tokenizr } from "tokenizr";
import { markov4, messages } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { BoundedMap } from "../utils/bounded-map";

enum Tokens {
	Space = "space",
	Punctuation = "punctuation",
	Word = "word",
	Eof = "EOF",
}

interface TokenWithCitation {
	token: string;
	messageId: string;
	channelId: string;
	guildId: string;
}
interface GeneratedMessage {
	content: string;
	citations: TokenWithCitation[];
}

const slashCommandSpec = new SlashCommandBuilder()
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

const citeCommandSpec = new ContextMenuCommandBuilder()
	.setType(ApplicationCommandType.Message)
	.setName("Cite");

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
	#citations: BoundedMap<string, TokenWithCitation[]> = new BoundedMap(500);

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

			// Register the commands. This will run asynchronously.
			Promise.all([
				this.#discord.registerSlashCommand(slashCommandSpec, (interaction) =>
					this.#handleSlashCommand(interaction),
				),
				this.#discord.registerMessageCommand(citeCommandSpec, (interaction) =>
					this.#handleCite(interaction),
				),
			]).then(() => Sentry.logger.info("MarkovService initialized"));
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

		const defer = wrapInteractionDo(interaction, "deferReply")({ withResponse: true });
		// Send non-ephemeral message
		const sendPublic = async (
			message: string | MessagePayload | InteractionEditReplyOptions,
		) => {
			await defer;
			return await wrapInteractionDo(interaction, "editReply")(message);
		};
		// Send ephemeral message
		const sendPrivate = async (message: InteractionReplyOptions) => {
			await defer;
			await wrapInteractionDo(interaction, "deleteReply")();
			return await wrapInteractionDo(
				interaction,
				"followUp",
			)({ ...message, flags: [MessageFlags.Ephemeral] });
		};

		try {
			const generatedMessage = await this.#generateMessage(prompt, target?.id);
			if (generatedMessage) {
				const response = await sendPublic({
					content: generatedMessage.content,
					allowedMentions: { parse: [] }, // silence mentions
				});
				Sentry.logger.info("Generated message from Markov model", {
					sentence: generatedMessage.content,
					citations: generatedMessage.citations.length,
				});
				this.#citations.set(response.id, generatedMessage.citations);
			} else {
				// Failed to generate sentence
				const targetMention = target ? `from ${userMention(target.id)}` : "";
				await sendPrivate({
					content: `⚠️ Error: cannot extrapolate from "${prompt}".
No messages in the database were found ${targetMention} which start with the prompt.`,
				});
			}
		} catch (err) {
			Sentry.captureException(err, { extra: { metadata } });
			const message = err instanceof Error ? err.message : String(err);
			await sendPrivate({ content: `⚠️ Error: ${message}` });
		}
	}

	/**
	 * Generates a message using the Markov model.
	 * @param prompt prompt to start the sentence with
	 * @param authorId optional author ID to filter on
	 * @returns the generated sentence, or null if the given prompt could not be expanded
	 */
	async #generateMessage(prompt: string, authorId?: string): Promise<GeneratedMessage | null> {
		const tokens = Array.from(this.#tokenize(prompt));
		const citations: TokenWithCitation[] = [];
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
				tokens.push(token.token);
				citations.push(token);
				if (tokens.length > 1000) {
					throw new Error("runaway message");
				}
			}
		});
		if (isFirstToken) {
			return null;
		}
		return { content: tokens.join(""), citations };
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
	): Promise<TokenWithCitation | null> {
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
			.select({
				token: markov4.word5,
				messageId: markov4.message_id,
				channelId: messages.channel_id,
				guildId: messages.guild_id,
			})
			.from(markov4)
			.innerJoin(messages, eq(markov4.message_id, messages.id))
			.where(filter)
			.limit(1)
			.offset(offset);
		if (result.length < 1 || result[0].token === null) return null;
		return { ...result[0], token: result[0].token! };
	}

	@traced("event.handler")
	async #handleCite(interaction: MessageContextMenuCommandInteraction) {
		const replyErr = async (message: string) => {
			await interaction.reply({
				content: `⚠️ Error: ${message}`,
				flags: [MessageFlags.Ephemeral],
			});
		};

		const message = interaction.targetMessage;
		Sentry.logger.info("Message citation requested", {
			"discord.message.id": message.id,
			"discord.channel.id": interaction.channelId,
			"discord.user.id": interaction.user.id,
		});

		if (message.author.id !== interaction.client.user.id) {
			return replyErr("I can only cite messages sent by me");
		}

		const citations = this.#citations.get(message.id);
		if (citations === undefined) {
			Sentry.logger.warn("No citations found for message", {
				"discord.message.id": message.id,
			});
			return replyErr(
				"No citations found for this message.\n" +
					"Either it is too old and the citations have been forgotten, " +
					"or it is not an imitation.",
			);
		}

		const deduplicatedCitations = citations
			.reduce<TokenWithCitation[]>((acc, cur) => {
				const last = acc.at(-1);
				if (last?.messageId === cur.messageId) {
					last.token += cur.token;
				} else {
					acc.push(cur);
				}
				return acc;
			}, [])
			.map((c) => ({ ...c, token: c.token.trim() }))
			.filter((c) => c.token !== "");
		let rendered = `Cited ${deduplicatedCitations.length} messages:`;
		let first = true;
		for (const c of deduplicatedCitations) {
			const line = `\n- ${c.token}: ${messageLink(c.channelId, c.messageId, c.guildId)}`;
			if (rendered.length + line.length > 2000) {
				await wrapInteractionDo(
					interaction,
					first ? "reply" : "followUp",
				)({ content: rendered, allowedMentions: { parse: [] } });
				first = false;
				rendered = "";
			}
			rendered += line;
		}
		if (rendered.length > 0) {
			await wrapInteractionDo(
				interaction,
				first ? "reply" : "followUp",
			)({ content: rendered, allowedMentions: { parse: [] } });
		}
		Sentry.logger.info("Message citation processed", {
			"citations.length": deduplicatedCitations.length,
			"discord.message.id": message.id,
		});
	}
}
