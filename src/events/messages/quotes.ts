import {
	ChannelType,
	Events,
	Message,
	MessageType,
	PermissionFlagsBits,
	type Client,
	type OmitPartialGroupDMChannel,
} from "discord.js";
import { QuoteCategories, Stickers } from "../../consts";
import { recordQuote, UniquenessError } from "../../db";

export function register(client: Client<true>) {
	client.on(Events.MessageCreate, (message) => {
		handler(message);
	});
}

async function handler(message: OmitPartialGroupDMChannel<Message<boolean>>) {
	// Only operate on text channels and public threads
	if (
		!(
			message.inGuild() &&
			message.channel.type in
				[ChannelType.GuildText, ChannelType.PublicThread]
		)
	)
		return;

	// Only operate on public channels
	if (
		message.channel.type == ChannelType.GuildText &&
		!message.channel
			.permissionsFor(message.guild!.roles.everyone)
			.has(PermissionFlagsBits.ViewChannel)
	)
		return;

	// Don't include messages sent using /freak
	if (message.author.bot) return;

	// Skip if message doesn't record a quote
	const category = getQuoteCategory(message);
	if (!category) return;

	// Record quote
	const quotedMessage = await getQuoteText(message);
	if (!quotedMessage) return;
	try {
		recordQuote(quotedMessage, category);
		console.log(
			`Recorded ${category} quote: ${quotedMessage.content.trim()}`,
		);
	} catch (error) {
		if (error instanceof UniquenessError) {
			console.warn(error);
		} else {
			throw error;
		}
	}
}

function getQuoteCategory(message: Message<true>): QuoteCategories | null {
	if (message.stickers.has(Stickers.AtharvaSays)) {
		return QuoteCategories.Atharva;
	}
	return null;
}

async function getQuoteText(
	message: Message<true>,
): Promise<Message<true> | null> {
	let quotedMessage = message;
	if (message.type === MessageType.Reply) {
		quotedMessage = await message.fetchReference();
	} else if (message.type !== MessageType.Default) {
		console.warn(
			`Found sticker on message of unsupported type ${message.type}`,
		);
		return null;
	}
	if (!quotedMessage.content.trim()) {
		console.warn("Candidate message for quote is empty");
		return null;
	}
	return quotedMessage;
}
