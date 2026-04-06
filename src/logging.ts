import type {
	GuildMember,
	Interaction,
	Message,
	MessageReaction,
	OmitPartialGroupDMChannel,
	PartialGuildMember,
	PartialMessage,
	PartialMessageReaction,
	PartialUser,
	User,
} from "discord.js";
import { configure, getLogger, type AppenderModule } from "log4js";
import * as Sentry from "@sentry/bun";
import { inspect } from "node:util";

// Log4JS appender to send logs to Sentry
const sentryAppender: AppenderModule = {
	configure: () => (event) => {
		const levelMap: Record<string, keyof typeof Sentry.logger> = {
			TRACE: "trace",
			DEBUG: "debug",
			INFO: "info",
			WARN: "warn",
			ERROR: "error",
			FATAL: "fatal",
		};
		const method = levelMap[event.level.levelStr];
		if (!method) return;
		const message = event.data
			.map((d: unknown) => (typeof d === "string" ? d : inspect(d, { depth: 4 })))
			.join(" ");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		Sentry.logger[method](message as any);
	},
};

const level = Bun.env.NODE_ENV === "production" ? "info" : "debug";
configure({
	appenders: {
		stdout: { type: "stdout" },
		sentry: { type: sentryAppender },
	},
	categories: {
		default: { appenders: ["stdout", "sentry"], level },
	},
});

export const log = getLogger();

// Use log4js for uncaught exceptions and promise rejections
process.on("uncaughtException", (error) => {
	log.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason, promise) => {
	log.error("Unhandled rejection:", { promise, reason });
});

/**
 * Wraps an event handler with a Sentry isolation scope, tagging it with the
 * handler name so that errors can be traced back to their origin.
 */
export function withSentryEventScope<TArgs extends unknown[], TReturn>(
	handlerName: string,
	fn: (...args: TArgs) => TReturn | Promise<TReturn>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	extractContext?: (...args: any[]) => void,
): (...args: TArgs) => Promise<TReturn> {
	return (...args: TArgs) =>
		Sentry.withIsolationScope(async () => {
			Sentry.setTag("handler", handlerName);
			extractContext?.(...args);
			try {
				return await fn(...args);
			} catch (error) {
				Sentry.captureException(error);
				throw error;
			}
		});
}

// Context extractors for common event types

export function extractMessageContext(message: Message) {
	addUser(message.author);
	addMessageContext(message);
}

export function extractMessageUpdateContext(
	oldMessage: OmitPartialGroupDMChannel<Message | PartialMessage>,
	newMessage: OmitPartialGroupDMChannel<Message>,
) {
	addUser(newMessage.author);
	if (oldMessage.partial) {
		Sentry.setContext("old message", {
			id: oldMessage.id,
			partial: true,
		});
	} else {
		addMessageContext(oldMessage as Message, "old message");
	}
	addMessageContext(newMessage as Message, "new message");
}

export function extractReactionContext(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
) {
	Sentry.setUser({ id: user.id, username: user.partial ? undefined : user.username });
	Sentry.setContext("reaction", {
		messageId: reaction.message.id,
		channelId: reaction.message.channelId,
		guildId: reaction.message.guildId,
		emoji: reaction.emoji.id ?? reaction.emoji.name,
	});
}

export function extractInteractionContext(interaction: Interaction) {
	Sentry.setUser({ id: interaction.user.id, username: interaction.user.username });
	Sentry.setContext("discord.interaction", {
		id: interaction.id,
		type: interaction.type,
		guildId: interaction.guildId,
		channelId: interaction.channelId,
	});
}

export function extractMemberContext(member: GuildMember | PartialGuildMember) {
	Sentry.setUser({ id: member.id, username: member.user?.username });
	Sentry.setContext("guild", {
		id: member.guild.id,
		name: member.guild.name,
	});
}

function addUser(user: User) {
	Sentry.setUser({
		id: user.id,
		username: user.username,
	});
}

function addMessageContext(message: Message, name: string = "message") {
	Sentry.setContext(name, {
		id: message.id,
		guild: message.inGuild()
			? {
					id: message.guildId,
					name: message.guild.name,
				}
			: null,
		channel: {
			id: message.channelId,
			name: message.inGuild() ? message.channel?.name : null,
		},
		author: {
			id: message.author.id,
			username: message.author.username,
		},
		timestamp: message.createdAt.toISOString(),
	});
}
