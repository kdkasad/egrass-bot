import * as Sentry from "@sentry/bun";
import type { Message, MessageEditOptions, MessagePayload, MessageReplyOptions } from "discord.js";

export function traced(op = "function") {
	return function <This, Args extends unknown[], Return>(
		target: (this: This, ...args: Args) => Promise<Return>,
		context: ClassMethodDecoratorContext<This>,
	) {
		return function (this: This, ...args: Args): Promise<Return> {
			const name = `${(this as any).constructor.name}.${String(context.name)}`;
			return Sentry.startSpan({ name, op }, () =>
				Sentry.withScope((scope) => {
					scope.setContext("service", {
						name: (this as any).constructor.name,
						method: String(context.name),
					});
					scope.setAttributes({
						"service.name": (this as any).constructor.name,
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
