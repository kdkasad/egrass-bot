CREATE TABLE `bounties` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poster_id` text NOT NULL,
	`task` text NOT NULL,
	`amount` integer NOT NULL,
	`requires_verification` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`closed_at` integer,
	`winner_id` text,
	`transaction_id` integer,
	FOREIGN KEY (`poster_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winner_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `exchange_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_bounties_status_expires_at` ON `bounties` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_bounties_poster_id` ON `bounties` (`poster_id`);--> statement-breakpoint
CREATE TABLE `bounty_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bounty_id` integer NOT NULL,
	`claimer_id` text NOT NULL,
	`proof` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`bounty_id`) REFERENCES `bounties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimer_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_bounty_claims_bounty_id_status` ON `bounty_claims` (`bounty_id`,`status`);