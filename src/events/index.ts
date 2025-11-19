import type { Client } from "discord.js";
import * as solves from "./reactions/solves";
import * as quotes from "./messages/quotes";
import * as markovTraining from "./messages/markov-training";
import * as memberTracking from "./members/track";
import * as sql from "./messages/sql";

interface Registerable {
	register(client: Client<true>): void | PromiseLike<void>;
}

const consumers: Registerable[] = [
	solves,
	quotes,
	markovTraining,
	memberTracking,
	sql,
];

export function register(client: Client<true>) {
	for (const consumer of consumers) {
		consumer.register(client);
	}
}
