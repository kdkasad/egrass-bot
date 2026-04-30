PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_markov4` (
	`message_id` text NOT NULL,
	`word1` text,
	`word2` text,
	`word3` text,
	`word4` text,
	`word5` text,
	`author_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_markov4`("message_id", "word1", "word2", "word3", "word4", "word5", "author_id") SELECT "message_id", "word1", "word2", "word3", "word4", "word5", "author_id" FROM `markov4`;--> statement-breakpoint
DROP TABLE `markov4`;--> statement-breakpoint
ALTER TABLE `__new_markov4` RENAME TO `markov4`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_markov4_message_id` ON `markov4` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_markov4_prefix` ON `markov4` (`word1`,`word2`,`word3`,`word4`);--> statement-breakpoint
CREATE INDEX `idx_markov4_author_prefix` ON `markov4` (`author_id`,`word1`,`word2`,`word3`,`word4`);