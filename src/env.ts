import { z } from "zod/mini";

const schema = z.object({
	DISCORD_BOT_TOKEN: z.string(),
	DISCORD_CLIENT_ID: z.string(),
});

export const env = schema.parse(Bun.env);
