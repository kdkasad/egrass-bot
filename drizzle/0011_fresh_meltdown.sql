ALTER TABLE `messages` RENAME COLUMN "id" TO "message_id";--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN "author_id" TO "user_id";--> statement-breakpoint
DROP VIEW `messages_with_author`;--> statement-breakpoint
DROP VIEW `polls`;--> statement-breakpoint
CREATE VIEW `messages_with_author` AS select "messages"."message_id", "messages"."guild_id", "messages"."channel_id", "messages"."user_id", "messages"."timestamp", "messages"."content", "messages"."replies_to", "messages"."is_poll", "members"."id", "members"."display_name", "members"."username", "members"."is_bot" from "messages" left join "members" on "messages"."user_id" = "members"."id";--> statement-breakpoint
CREATE VIEW `polls` AS select "message_id", "guild_id", "channel_id", "user_id", "timestamp", "content", "replies_to" from "messages" where "messages"."is_poll" = 1;
