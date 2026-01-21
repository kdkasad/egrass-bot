import type { Client } from "discord.js";
import * as solves from "./reactions/solves";
import * as reactionTracking from "./reactions/track";
import * as quotes from "./messages/quotes";
import * as markovTraining from "./messages/markov-training";
import * as memberTracking from "./members/track";
import * as sql from "./messages/sql";
import * as atharvaDms from "./messages/atharva-dms";
import * as recap from "./interactions/recap";
import * as bruh from "./messages/bruh";

interface Registerable {
	register(client: Client<true>): void | PromiseLike<void>;
}

const consumers: Registerable[] = [
	solves,
	reactionTracking,
	quotes,
	markovTraining,
	memberTracking,
	sql,
	atharvaDms,
	recap,
	bruh,
];

export function register(client: Client<true>) {
	for (const consumer of consumers) {
		consumer.register(client);
	}
}
