import {
	Collection,
	SharedSlashCommand,
	type ChatInputCommandInteraction,
} from "discord.js";
import * as neetcode from "./neetcode";
import * as imitate from "./imitate";
import * as markov from "./markov";
import * as minecraft from "./minecraft";
import * as recap from "./recap";

export type CommandHandler = (
	interaction: ChatInputCommandInteraction,
) => Promise<void>;

export interface Command {
	data: SharedSlashCommand;
	execute: CommandHandler;
}

const commandList: Command[] = [neetcode, imitate, markov, minecraft, recap];

export const commands: Collection<string, Command> = Collection.combineEntries(
	commandList.map((command) => [command.data.name, command]),
	(_a, b) => b,
);
