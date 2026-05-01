DROP INDEX `idx_markov4_prefix`;--> statement-breakpoint
DROP INDEX `idx_markov4_author_prefix`;--> statement-breakpoint
CREATE INDEX `idx_markov4_prefix_author` ON `markov4` (`word1`,`word2`,`word3`,`word4`,`author_id`);