import {
	AttachmentBuilder,
	ChannelType,
	type Client,
	type Message,
	type OmitPartialGroupDMChannel,
} from "discord.js";
import { Users } from "../../consts";
import yumImage from "../../../assets/yum.gif" with { type: "file" };

const yumImageBuf = Buffer.from(
	await Bun.file(yumImage, {
		type: "image/gif",
	}).arrayBuffer(),
);

export function register(client: Client<true>) {
	client.on("messageCreate", handleMessage);
}

async function handleMessage(message: OmitPartialGroupDMChannel<Message>) {
	const channel = message.channel.partial
		? await message.channel.fetch()
		: message.channel;
	if (channel.type != ChannelType.DM) return;
	if (message.author.id !== Users.Atharva) return;

	await message.reply({
		files: [
			new AttachmentBuilder(Buffer.from(yumImageBuf), {
				name: "yum.gif",
			}),
		],
	});
}
