import { type Client, type Message } from "discord.js";
import { Tokenizr } from "tokenizr";
import {
	clearMarkovModel,
	createMarkov4Entry,
	doInTransaction,
	getAllMessages,
	getNextMarkovToken,
	type Markov4Row,
} from "./db";
import { Guilds } from "./consts";

enum Tokens {
	Space = "space",
	Punctuation = "punctuation",
	Word = "word",
	Eof = "EOF",
}

export function* tokenize(message: string) {
	const lexer = new Tokenizr();
	lexer.rule(/\p{Separator}+/u, (ctx) => {
		ctx.accept(Tokens.Space);
	});
	lexer.rule(/[\p{Punctuation}\p{Symbol}]/u, (ctx) => {
		ctx.accept(Tokens.Punctuation);
	});
	lexer.rule(/[^\p{Punctuation}\p{Symbol}\p{Separator}]+/u, (ctx) => {
		ctx.accept(Tokens.Word);
	});
	lexer.input(message);
	while (true) {
		const token = lexer.token()!;
		if (token.type === Tokens.Eof) {
			return token.text;
		} else {
			yield token.text;
		}
	}
}

export function addMessageToMarkov4(
	message: Pick<Message, "id" | "content">,
	authorId: Markov4Row["author_id"],
) {
	const prefix: (string | null)[] = [null, null, null, null];
	for (const token of tokenize(message.content)) {
		createMarkov4Entry(
			message.id,
			authorId,
			prefix[0],
			prefix[1],
			prefix[2],
			prefix[3],
			token,
		);
		prefix.shift();
		prefix.push(token);
	}
	createMarkov4Entry(
		message.id,
		authorId,
		prefix[0],
		prefix[1],
		prefix[2],
		prefix[3],
		null,
	);
}

export function generateSentence(authorId?: string): string {
	const tokens: string[] = [];
	doInTransaction(() => {
		while (true) {
			const token = getNextMarkovToken(
				authorId,
				tokens.at(-4) ?? null,
				tokens.at(-3) ?? null,
				tokens.at(-2) ?? null,
				tokens.at(-1) ?? null,
			);
			if (token === null) break;
			tokens.push(token);
			if (tokens.length > 1000) {
				throw new Error("runaway message");
			}
		}
	})();
	return tokens.join("");
}

export async function retrainModel(client: Client<true>) {
	console.log("Retraining model...");

	// Populate users in cache
	const guild = await client.guilds.fetch(Guilds.Egrass);
	await guild.members.fetch();

	console.debug("Populating markov4 table...");
	doInTransaction(async () => {
		clearMarkovModel();
		for (const message of getAllMessages()) {
			const user = client.users.cache.get(message.author_id);
			if (user?.bot) continue;
			addMessageToMarkov4(message, message.author_id);
		}
	})();
	console.debug("Done populating markov4 table");
	console.log("Done re-training");
}
