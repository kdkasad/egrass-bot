import * as Sentry from "@sentry/bun";
import type {
	EmojiIdentifierResolvable,
	Message,
	MessageEditOptions,
	MessagePayload,
	MessageReplyOptions,
	RepliableInteraction,
} from "discord.js";

export function traced(op = "function") {
	return function <This, Args extends unknown[], Return>(
		target: (this: This, ...args: Args) => Promise<Return>,
		context: ClassMethodDecoratorContext<This>,
	) {
		return function (this: This, ...args: Args): Promise<Return> {
			const name = (this as object).constructor.name;
			return Sentry.startSpan({ name: `${name}.${String(context.name)}`, op }, () =>
				Sentry.withScope((scope) => {
					scope.setContext("service", { name, method: String(context.name) });
					scope.setAttributes({
						"service.name": name,
						"service.method": String(context.name),
					});
					return target.apply(this, args);
				}),
			);
		};
	};
}

/**
 * Tracing-enabled wrapper around {@link Message.reply()}.
 */
export async function replyToMessage(
	message: Message,
	payload: string | MessagePayload | MessageReplyOptions,
) {
	return Sentry.startSpan(
		{
			name: "reply to message",
			op: "discord.send",
			attributes: {
				"message.id": message.id,
				"channel.id": message.channel.id,
				"guild.id": message.guild?.id,
				"user.id": message.author.id,
			},
		},
		() => message.reply(payload),
	);
}

export async function editMessage(
	message: Message,
	payload: string | MessagePayload | MessageEditOptions,
) {
	return Sentry.startSpan(
		{
			name: "edit message",
			op: "discord.send",
			attributes: {
				"message.id": message.id,
				"channel.id": message.channel.id,
				"guild.id": message.guild?.id,
				"user.id": message.author.id,
			},
		},
		() => message.edit(payload),
	);
}

export async function addReaction(message: Message, emoji: string | EmojiIdentifierResolvable) {
	return Sentry.startSpan(
		{
			name: "add reaction",
			op: "discord.send",
			attributes: {
				"message.id": message.id,
				"channel.id": message.channel.id,
				"guild.id": message.guild?.id,
				"user.id": message.author.id,
			},
		},
		() => message.react(emoji),
	);
}

export function wrapInteractionDo<K extends keyof RepliableInteraction>(
	interaction: RepliableInteraction,
	name: K,
): RepliableInteraction[K] {
	const method = interaction[name];
	return ((...args: unknown[]) => {
		return Sentry.startSpan(
			{
				name: `discord.interaction.${name}`,
				op: "discord.send",
				attributes: {
					"discord.interaction.id": interaction.id,
					"discord.user.id": interaction.user.id,
				},
			},
			() => (method as (...args: unknown[]) => Promise<unknown>).apply(interaction, args),
		);
	}) as RepliableInteraction[K];
}
