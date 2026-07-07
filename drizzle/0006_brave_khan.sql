CREATE TABLE `exchange_balances` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exchange_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sender_id` text,
	`recipient_id` text NOT NULL,
	`amount` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`memo` text NOT NULL,
	`message_id` text,
	FOREIGN KEY (`sender_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
