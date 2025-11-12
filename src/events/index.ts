import type { Client } from "discord.js";
import * as solves from "./reactions/solves";
import * as quotes from "./messages/quotes";
import * as markovTraining from "./messages/markov-training";

export function register(client: Client<true>) {
	solves.register(client);
	quotes.register(client);
	markovTraining.register(client);
}
