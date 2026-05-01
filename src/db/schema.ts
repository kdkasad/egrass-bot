import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const neetcodeProblems = sqliteTable(
	"neetcode_problems",
	{
		date: integer("date").notNull(),
		url: text("url").notNull().unique(),
	},
	(t) => [uniqueIndex("idx_problems_date_url").on(t.date, t.url)],
);

export const neetcodeAnnouncements = sqliteTable(
	"neetcode_announcements",
	{
		message_id: text("message_id").primaryKey().notNull(),
		date: integer("date").notNull().unique(),
	},
	(t) => [index("idx_announcements_date").on(t.date)],
);

export const neetcodeSolves = sqliteTable(
	"neetcode_solves",
	{
		user_id: text("user_id").notNull(),
		solve_time: integer("solve_time"),
		announcement_id: text("announcement_id")
			.notNull()
			.references(() => neetcodeAnnouncements.message_id),
	},
	(t) => [
		index("idx_solves_announcement_id").on(t.announcement_id),
		uniqueIndex("idx_solves_user_id_announcement_id").on(t.user_id, t.announcement_id),
	],
);

export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		guild_id: text("guild_id").notNull(),
		channel_id: text("channel_id").notNull(),
		author_id: text("author_id").notNull(),
		timestamp: integer("timestamp").notNull(),
		content: text("content").notNull(),
		replies_to: text("replies_to"),
	},
	(t) => [index("idx_messages_author").on(t.author_id)],
);

export const markov4 = sqliteTable(
	"markov4",
	{
		message_id: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		word1: text("word1"),
		word2: text("word2"),
		word3: text("word3"),
		word4: text("word4"),
		word5: text("word5"),
		author_id: text("author_id"),
	},
	(t) => [
		index("idx_markov4_message_id").on(t.message_id),
		index("idx_markov4_prefix_author").on(t.word1, t.word2, t.word3, t.word4, t.author_id),
	],
);

export const members = sqliteTable("members", {
	id: text("id").primaryKey(),
	display_name: text("display_name").notNull(),
	username: text("username").notNull(),
});

export const sql_responses = sqliteTable("sql_responses", {
	query_id: text("query_id").primaryKey(),
	response_id: text("response_id").notNull().unique(),
});

export const minecraft = sqliteTable("minecraft", {
	discord_id: text("discord_id")
		.primaryKey()
		.references(() => members.id),
	mc_username: text("mc_username").notNull().unique(),
});

export const reactions = sqliteTable(
	"reactions",
	{
		message_id: text("message_id").notNull(),
		user_id: text("user_id").notNull(),
		emoji: text("emoji").notNull(),
		timestamp: integer("timestamp").notNull(),
	},
	(t) => [primaryKey({ columns: [t.message_id, t.user_id, t.emoji] })],
);

export const mutes = sqliteTable("mutes", {
	user_id: text("user_id").primaryKey(),
	expires_at: integer("expires_at").notNull(),
});
