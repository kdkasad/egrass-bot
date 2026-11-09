CREATE TABLE `anon_poll_choices` (
	`poll_id` text NOT NULL,
	`choice_id` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`poll_id`, `choice_id`),
	FOREIGN KEY (`poll_id`) REFERENCES `anon_polls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `anon_poll_voters` (
	`poll_id` text NOT NULL,
	`voter` text NOT NULL,
	PRIMARY KEY(`poll_id`, `voter`),
	FOREIGN KEY (`poll_id`) REFERENCES `anon_polls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `anon_polls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`question` text NOT NULL,
	`message_id` text,
	`closes_at` integer NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`tally` blob NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_anon_polls_closed_deadline` ON `anon_polls` (`closed`,`closes_at`);