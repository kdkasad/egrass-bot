import type { Message } from "discord.js";
import { Tokenizr } from "tokenizr";
import { createMarkov4Entry, doInTransaction, getNextMarkovToken } from "./db";

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

export function addMessageToMarkov4(message: Message) {
	const prefix: (string | null)[] = [null, null, null, null];
	for (const token of tokenize(message.content)) {
		createMarkov4Entry(
			message,
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
		}
	})();
	return tokens.join("");
}
