CREATE TABLE `poll_choices` (
	`message_id` text,
	`choice_id` integer NOT NULL,
	`text` text,
	`emoji` text,
	PRIMARY KEY(`message_id`, `choice_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_poll_choices` ON `poll_choices` (`message_id`,`choice_id`);--> statement-breakpoint
CREATE TABLE `poll_responses` (
	`message_id` text NOT NULL,
	`choice_id` integer NOT NULL,
	`user_id` text,
	PRIMARY KEY(`message_id`, `choice_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`,`choice_id`) REFERENCES `poll_choices`(`message_id`,`choice_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_poll_responses` ON `poll_responses` (`message_id`,`choice_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `is_poll` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE VIEW `polls` AS select "id", "guild_id", "channel_id", "author_id", "timestamp", "content", "replies_to" from "messages" where "messages"."is_poll" = 1;