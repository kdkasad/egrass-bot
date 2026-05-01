ALTER TABLE `announcements` RENAME TO `neetcode_announcements`;--> statement-breakpoint
ALTER TABLE `problems` RENAME TO `neetcode_problems`;--> statement-breakpoint
ALTER TABLE `solves` RENAME TO `neetcode_solves`;--> statement-breakpoint
DROP INDEX `announcements_date_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `neetcode_announcements_date_unique` ON `neetcode_announcements` (`date`);--> statement-breakpoint
DROP INDEX `problems_url_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `neetcode_problems_url_unique` ON `neetcode_problems` (`url`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_neetcode_solves` (
	`user_id` text NOT NULL,
	`solve_time` integer,
	`announcement_id` text NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `neetcode_announcements`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_neetcode_solves`("user_id", "solve_time", "announcement_id") SELECT "user_id", "solve_time", "announcement_id" FROM `neetcode_solves`;--> statement-breakpoint
DROP TABLE `neetcode_solves`;--> statement-breakpoint
ALTER TABLE `__new_neetcode_solves` RENAME TO `neetcode_solves`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_solves_announcement_id` ON `neetcode_solves` (`announcement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_solves_user_id_announcement_id` ON `neetcode_solves` (`user_id`,`announcement_id`);