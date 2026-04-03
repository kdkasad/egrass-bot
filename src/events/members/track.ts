import type { Client } from "discord.js";
import { addOrUpdateMember, doInTransaction } from "../../db";
import { Guilds } from "../../consts";
import { extractMemberContext, log, withSentryEventScope } from "../../logging";

export function register(client: Client<true>) {
	// Populate initial members
	(async () => {
		const guild = await client.guilds.fetch(Guilds.Egrass);
		const members = await guild.members.fetch();
		doInTransaction(() => {
			for (const member of members.values()) {
				addOrUpdateMember(member);
			}
		})();
	})();

	// Track changes to members
	client
		.on("guildMemberAdd", withSentryEventScope("member-track", async (member) => {
			addOrUpdateMember(member);
			log.info("Guild member added", { name: member.displayName });
		}, extractMemberContext))
		.on("guildMemberUpdate", withSentryEventScope("member-track", async (_oldMember, newMember) => {
			addOrUpdateMember(newMember);
			log.debug("Guild member updated", {
				oldName: newMember.displayName,
				newName: newMember.displayName,
			});
		}, (_old, member) => extractMemberContext(member)))
		.on("guildMemberRemove", withSentryEventScope("member-track", async (member) => {
			// deleteMember(member);
			log.info("Guild member left", { name: member.displayName });
		}, extractMemberContext));
}
