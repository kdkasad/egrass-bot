import {
	Collection,
	SharedSlashCommand,
	type ChatInputCommandInteraction,
} from "discord.js";
import * as neetcode from "./neetcode";
import * as imitate from "./imitate";
import * as markov from "./markov";

export type CommandHandler = (
	interaction: ChatInputCommandInteraction,
) => Promise<void>;

export interface Command {
	data: SharedSlashCommand;
	execute: CommandHandler;
}

const commandList: Command[] = [neetcode, imitate, markov];

export const commands: Collection<string, Command> = Collection.combineEntries(
	commandList.map((command) => [command.data.name, command]),
	(_a, b) => b,
);
