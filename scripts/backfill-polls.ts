import {
	REST,
	Routes,
	MessageReferenceType,
	type APIMessage,
	type APIMessageSearchResult,
	type RESTGetAPIPollAnswerVotersResult,
} from "discord.js";
import { Guilds } from "../src/consts";

async function searchForPolls(rest: REST, cacheFile: Bun.BunFile): Promise<APIMessage[]> {
	console.time("search");
	const pollMessages: APIMessage[] = [];
	let totalPolls: number | undefined;
	while (true) {
		const offset = pollMessages.length;
		const limit = 25;
		console.log(`Fetching polls [${offset}, ${offset + limit}) out of ${totalPolls ?? "??"}`);
		const response = (await rest.get(Routes.guildMessagesSearch(Guilds.Egrass), {
			query: new URLSearchParams({
				has: "poll",
				offset: String(offset),
				limit: String(limit),
			}),
		})) as APIMessageSearchResult;
		if (response.messages.length === 0) break;
		totalPolls = response.total_results;
		pollMessages.push(...response.messages.flat());
	}
	console.timeEnd("search");
	cacheFile.write(JSON.stringify(pollMessages));
	return pollMessages;
}

type Vote = { messageId: string; answerId: number; userId: string };
async function getVotesForPoll(poll: APIMessage, rest: REST): Promise<Vote[]> {
	if (poll.poll === undefined) throw new Error("message is not a poll");
	const votesPerAnswer = await Promise.all(
		poll.poll.answers.flatMap(async (answer) =>
			(
				rest.get(Routes.pollAnswerVoters(poll.channel_id, poll.id, answer.answer_id), {
					query: new URLSearchParams({ limit: "100" }),
				}) as Promise<RESTGetAPIPollAnswerVotersResult>
			).then(
				(response) =>
					response.users.map((user) => ({
						messageId: poll.id,
						answerId: answer.answer_id,
						userId: user.id,
					})) satisfies Vote[],
			),
		),
	);
	return votesPerAnswer.flat();
}

const rest = new REST({ authPrefix: "Bot" }).setToken(Bun.env.DISCORD_BOT_TOKEN!);

const pollsCacheFile = Bun.file("/tmp/egrass_polls.json");
const polls: APIMessage[] = (await pollsCacheFile.exists())
	? await pollsCacheFile.json()
	: await searchForPolls(rest, pollsCacheFile);

const votesFile = Bun.file("/tmp/egrass_votes.json");
const votes: Vote[] = (await votesFile.exists()) ? await votesFile.json() : [];
if (votes.length === 0) {
	console.time("votes");
	for (const [i, poll] of polls.entries()) {
		console.log(`Fetching votes for poll ${i + 1}/${polls.length}`);
		const votesForPoll = await getVotesForPoll(poll, rest);
		votes.push(...votesForPoll);
	}
	votesFile.write(JSON.stringify(votes));
	console.timeEnd("votes");
}

function sqlValue(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${value.replaceAll("'", "''")}'`;
}

function valuesClause(rows: (string | number | null)[][]): string {
	if (rows.length === 0) throw new Error("Cannot create an INSERT with no rows");
	return rows.map((row) => `(${row.map(sqlValue).join(", ")})`).join(",\n");
}

const messageRows = polls.map((message) => {
	if (!message.poll) throw new Error(`Message ${message.id} is not a poll`);
	const reference = message.message_reference;
	const repliesTo =
		reference?.message_id &&
		(reference.type === undefined || reference.type === MessageReferenceType.Default)
			? reference.message_id
			: null;
	return [
		message.id,
		Guilds.Egrass,
		message.channel_id,
		message.author.id,
		Math.floor(Date.parse(message.timestamp) / 1000),
		message.poll.question.text ?? message.content,
		repliesTo,
		1,
	] satisfies (string | number | null)[];
});

const choiceRows = polls.flatMap((message) => {
	if (!message.poll) throw new Error(`Message ${message.id} is not a poll`);
	return message.poll.answers.map(
		(answer) =>
			[
				message.id,
				answer.answer_id,
				answer.poll_media.text ?? null,
				answer.poll_media.emoji?.id ?? answer.poll_media.emoji?.name ?? null,
			] satisfies (string | number | null)[],
	);
});

const voteRows = votes.map(
	(vote) => [vote.messageId, vote.answerId, vote.userId] satisfies (string | number | null)[],
);

const statements = [
	`INSERT INTO messages
  (id, guild_id, channel_id, author_id, timestamp, content, replies_to, is_poll)
VALUES
${valuesClause(messageRows)}
ON CONFLICT (id) DO UPDATE SET
  content = excluded.content,
  is_poll = excluded.is_poll;`,
	`INSERT INTO poll_choices (message_id, choice_id, text, emoji)
VALUES
${valuesClause(choiceRows)}
ON CONFLICT (message_id, choice_id) DO UPDATE SET
  text = excluded.text,
  emoji = excluded.emoji;`,
	`INSERT INTO poll_responses (message_id, choice_id, user_id)
VALUES
${valuesClause(voteRows)}
ON CONFLICT (message_id, choice_id, user_id) DO NOTHING;`,
];

const sqlFile = Bun.file("/tmp/egrass_polls.sql");
await sqlFile.write(`${statements.join("\n\n")}\n`);
console.log(`Wrote ${statements.length} INSERT statements to ${sqlFile.name}`);
