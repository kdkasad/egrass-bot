import type {
	Message,
	OmitPartialGroupDMChannel,
	PartialMessage,
	User,
} from "discord.js";
import { getLogger } from "log4js";
import * as Sentry from "@sentry/bun";

export const log = getLogger();
if (Bun.env.NODE_ENV === "production") {
	log.level = "info";
} else {
	log.level = "debug";
	log.debug("Debug logging enabled");
}

// Use log4js for uncaught exceptions and promise rejections
process.on("uncaughtException", (error) => {
	log.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason, promise) => {
	log.error("Unhandled rejection:", { promise, reason });
});

type MessageHandler<T> = (message: Message) => Promise<T>;
/**
 * Wraps a given function which handles a message event with logic to attach
 * Sentry contexts containing information about the message.
 */
export function sentryMessageEventWrapper<T>(
	fn: MessageHandler<T>,
): MessageHandler<T> {
	return (message: Message) =>
		Sentry.withIsolationScope(async () => {
			addUser(message.author);
			addMessageContext(message);
			try {
				return await fn(message);
			} catch (error) {
				Sentry.captureException(error);
				throw error;
			}
		});
}

type MessageUpdateHandler<T> = (
	oldMessage: OmitPartialGroupDMChannel<Message | PartialMessage>,
	newMessage: Message,
) => Promise<T>;
/**
 * Wraps a given function which handles a message update event with logic to
 * attach Sentry contexts containing information about the message.
 */
export function sentryMessageUpdateEventWrapper<T>(
	fn: MessageUpdateHandler<T>,
): MessageUpdateHandler<T> {
	return (oldMessage, newMessage) =>
		Sentry.withIsolationScope(async () => {
			addUser(newMessage.author);
			if (oldMessage.partial) {
				Sentry.setContext("old message", {
					id: oldMessage.id,
					partial: true,
				});
			} else {
				addMessageContext(oldMessage, "old message");
			}
			addMessageContext(newMessage, "new message");
			try {
				return await fn(oldMessage, newMessage);
			} catch (error) {
				Sentry.captureException(error);
				throw error;
			}
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
