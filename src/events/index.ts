import type { Client } from "discord.js";
import * as solves from "./reactions/solves";

export function register(client: Client<true>) {
	solves.register(client);
}
