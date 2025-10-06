import { REST, Routes } from "discord.js";
import { Channels } from "../src/consts";
import { env } from "../src/env";

const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);
const pins = await rest.get(Routes.channelMessagesPins(Channels.Neetcode));
if (pins.has_more) {
	throw new Error("Too many pins; pagination not implemented");
}
for (const pin of pins.items) {
	const reactedUsers = await rest.get(
		Routes.channelMessageReaction(
			Channels.Neetcode,
			pin.message.id,
			encodeURIComponent("✅"),
		),
	);
	const date = new Date(pin.message.timestamp);
	date.setHours(0, 0, 0, 0);
	const timestamp = date.getTime() / 1000;
	console.log(`INSERT INTO announcements (message_id, date) VALUES ('${pin.message.id}', ${timestamp});`);
	for (const user of reactedUsers) {
		console.log(`INSERT INTO solves (user_id, announcement_id) VALUES ('${user.id}', '${pin.message.id}');`);
	}
}
