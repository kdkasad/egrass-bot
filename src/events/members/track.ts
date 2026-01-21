import type { Client } from "discord.js";
import { addOrUpdateMember, deleteMember, doInTransaction } from "../../db";
import { Guilds } from "../../consts";
import { log } from "../../logging";

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
		.on("guildMemberAdd", (member) => {
			addOrUpdateMember(member);
			log.info("Guild member added", { name: member.displayName });
		})
		.on("guildMemberUpdate", (oldMember, newMember) => {
			addOrUpdateMember(newMember);
			log.debug("Guild member updated", {
				oldName: newMember.displayName,
				newName: newMember.displayName,
			});
		})
		.on("guildMemberRemove", (member) => {
			deleteMember(member);
			log.info("Guild member deleted", { name: member.displayName });
		});
}
