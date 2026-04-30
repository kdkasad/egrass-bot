CREATE TABLE `announcements` (
	`message_id` text PRIMARY KEY NOT NULL,
	`date` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcements_date_unique` ON `announcements` (`date`);--> statement-breakpoint
CREATE INDEX `idx_announcements_date` ON `announcements` (`date`);--> statement-breakpoint
CREATE TABLE `markov4` (
	`message_id` text NOT NULL,
	`word1` text,
	`word2` text,
	`word3` text,
	`word4` text,
	`word5` text,
	`author_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_markov4_message_id` ON `markov4` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_markov4_prefix` ON `markov4` (`word1`,`word2`,`word3`,`word4`);--> statement-breakpoint
CREATE INDEX `idx_markov4_author_prefix` ON `markov4` (`author_id`,`word1`,`word2`,`word3`,`word4`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`username` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`timestamp` integer NOT NULL,
	`content` text NOT NULL,
	`replies_to` text
);
--> statement-breakpoint
CREATE INDEX `idx_messages_author` ON `messages` (`author_id`);--> statement-breakpoint
CREATE TABLE `minecraft` (
	`discord_id` text PRIMARY KEY NOT NULL,
	`mc_username` text NOT NULL,
	FOREIGN KEY (`discord_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `minecraft_mc_username_unique` ON `minecraft` (`mc_username`);--> statement-breakpoint
CREATE TABLE `mutes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `problems` (
	`date` integer NOT NULL,
	`url` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `problems_url_unique` ON `problems` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_problems_date_url` ON `problems` (`date`,`url`);--> statement-breakpoint
CREATE INDEX `idx_problems_date` ON `problems` (`date`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`category` text NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`quote` text NOT NULL,
	`author_user_id` text NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_quotes_category` ON `quotes` (`category`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_quotes_category_channel_message` ON `quotes` (`category`,`guild_id`,`channel_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`timestamp` integer NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`, `emoji`)
);
--> statement-breakpoint
CREATE TABLE `solves` (
	`user_id` text NOT NULL,
	`solve_time` integer,
	`announcement_id` text NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_solves_user_id` ON `solves` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_solves_announcement_id` ON `solves` (`announcement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_solves_user_id_announcement_id` ON `solves` (`user_id`,`announcement_id`);--> statement-breakpoint
CREATE TABLE `sql_responses` (
	`query_id` text PRIMARY KEY NOT NULL,
	`response_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sql_responses_response_id_unique` ON `sql_responses` (`response_id`);