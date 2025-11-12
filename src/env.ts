import { z } from "zod/mini";

const schema = z.object({
	DISCORD_BOT_TOKEN: z.string(),
	DISCORD_CLIENT_ID: z.string(),
	DISABLE_NEETCODE_ANNOUNCEMENTS: z._default(z.coerce.boolean(), false),
});

export const env = schema.parse(Bun.env);
