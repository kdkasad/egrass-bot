import { Collection, type Client, type Message } from "discord.js";
import { Tokenizr } from "tokenizr";
import {
	clearMarkovModel,
	createMarkov4Entry,
	db,
	doInTransaction,
	getAllMessages,
	getNextMarkovToken,
	type Markov4Row,
} from "./db";

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
	console.debug("Fetching users...");
	const fetchUserPromises = new Collection<string, Promise<unknown>>();
	for (const message of getAllMessages()) {
		if (!fetchUserPromises.has(message.author_id)) {
			fetchUserPromises.set(
				message.author_id,
				client.users.fetch(message.author_id, {
					cache: true,
					force: true,
				}),
			);
		}
	}
	console.debug("Done iterating to find users; waiting for fetch results...");
	await Promise.all(fetchUserPromises.values());
	console.debug("Done fetching users");

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
