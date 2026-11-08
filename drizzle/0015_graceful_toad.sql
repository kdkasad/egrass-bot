CREATE TABLE `anon_poll_voters` (
	`poll_id` text NOT NULL,
	`voter` text NOT NULL,
	PRIMARY KEY(`poll_id`, `voter`),
	FOREIGN KEY (`poll_id`) REFERENCES `anon_polls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `anon_polls` (
	`id` text PRIMARY KEY NOT NULL,
	`info` blob NOT NULL,
	`tally` blob NOT NULL
);
