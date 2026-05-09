import { generateAPIKey } from "../src/utils/middleware";

const secret = Bun.env.AUTH_SECRET;
if (!secret) throw new Error("AUTH_SECRET not set");

console.log(generateAPIKey(secret));
