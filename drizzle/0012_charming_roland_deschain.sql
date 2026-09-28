ALTER TABLE `members` RENAME COLUMN "id" TO "user_id";--> statement-breakpoint
-- manually edited
DROP VIEW `messages_with_author`;--> statement-breakpoint
CREATE VIEW `messages_with_author` AS select "messages"."message_id", "messages"."guild_id", "messages"."channel_id", "messages"."user_id", "messages"."timestamp", "messages"."content", "messages"."replies_to", "messages"."is_poll", "members"."user_id", "members"."display_name", "members"."username", "members"."is_bot" from "messages" left join "members" on "messages"."user_id" = "members"."user_id";
