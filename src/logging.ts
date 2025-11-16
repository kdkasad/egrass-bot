import { getLogger } from "log4js";

export const log = getLogger();
if (Bun.env.NODE_ENV === "production") {
	log.level = "info";
} else {
	log.level = "debug";
	log.debug("Debug logging enabled");
}

// Use log4js for uncaught exceptions and promise rejections
process.on("uncaughtException", (error) => {
	log.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason, promise) => {
	log.error("Unhandled rejection:", { promise, reason });
});
