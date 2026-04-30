import {
	GatewayIntentBits,
	Partials,
	Client,
	ActivityType,
	type ClientEvents,
	ChannelType,
	type ChatInputApplicationCommandData,
	type JSONEncodable,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	ChatInputCommandInteraction,
	InteractionType,
	type UserResolvable,
	MessagePayload,
	type MessageCreateOptions,
} from "discord.js";
import * as Sentry from "@sentry/bun";
import { Feature } from "../utils/service";
import { traced } from "../utils/tracing";
import { EnvService } from "./env";
import { flatten } from "../utils/flatten";

type SpanAttributes = Exclude<Parameters<typeof Sentry.startSpan>[0]["attributes"], undefined>;
interface EventDescriptor<K extends keyof ClientEvents> {
	discordJsName: K;
	spanName: string;
	logger: (...data: ClientEvents[K]) => void;
	attributes?: (...data: ClientEvents[K]) => SpanAttributes;
}

/**
 * Defines the events our {@link DiscordService} can handle.
 */
const events = {
	"message:create": {
		discordJsName: "messageCreate",
		spanName: "message created",
		attributes: (msg) => ({
			"discord.message.id": msg.id,
			"discord.channel.id": msg.channelId,
			"discord.channel.type": ChannelType[msg.channel.type],
			"discord.user.id": msg.author.id,
			"discord.guild.id": msg.guildId ?? "none",
		}),
		logger: (msg) => {
			Sentry.logger.info(
				"Message created",
				flatten({
					message: { id: msg.id },
					channel: {
						id: msg.channel.id,
						name: msg.channel.isDMBased() ? "DM" : msg.channel.name,
						type: ChannelType[msg.channel.type],
					},
					author: {
						id: msg.author.id,
						name: msg.author.displayName,
						bot: msg.author.bot,
					},
				}),
			);
		},
	} satisfies EventDescriptor<"messageCreate">,
	"message:delete": {
		discordJsName: "messageDelete",
		spanName: "message deleted",
		attributes: (msg) => ({
			"discord.message.id": msg.id,
			"discord.channel.id": msg.channelId,
			"discord.channel.type": ChannelType[msg.channel.type],
			"discord.user.id": msg.author?.id ?? "unknown",
			"discord.guild.id": msg.guildId ?? "none",
		}),
		logger: (msg) =>
			Sentry.logger.info(
				"Message deleted",
				flatten({
					message: { id: msg.id },
					channel: {
						id: msg.channel.id,
						name: msg.channel.isDMBased() ? "DM" : msg.channel.name,
						type: ChannelType[msg.channel.type],
					},
					author: {
						id: msg.author?.id ?? "unknown",
						name: msg.author?.displayName ?? "unknown",
						bot: msg.author?.bot ?? "unknown",
					},
				}),
			),
	} satisfies EventDescriptor<"messageDelete">,
	"message:edit": {
		discordJsName: "messageUpdate",
		spanName: "message edited",
		attributes: (oldMsg, newMsg) => ({
			"discord.message.id": newMsg.id,
			"discord.channel.id": newMsg.channelId,
			"discord.channel.type": ChannelType[newMsg.channel.type],
			"discord.user.id": newMsg.author?.id ?? "unknown",
			"discord.guild.id": newMsg.guildId ?? "none",
		}),
		logger: (oldMsg, newMsg) =>
			Sentry.logger.info(
				"Message deleted",
				flatten({
					message: { id: newMsg.id },
					channel: {
						id: newMsg.channel.id,
						name: newMsg.channel.isDMBased() ? "DM" : newMsg.channel.name,
						type: ChannelType[newMsg.channel.type],
					},
					author: {
						id: newMsg.author?.id ?? "unknown",
						name: newMsg.author?.displayName ?? "unknown",
						bot: newMsg.author?.bot ?? "unknown",
					},
				}),
			),
	} satisfies EventDescriptor<"messageUpdate">,
	"reaction:create": {
		discordJsName: "messageReactionAdd",
		spanName: "reaction added",
		attributes: (react, user) => ({
			"discord.message.id": react.message.id,
			"discord.user.id": user.id,
		}),
		logger: (react, user) =>
			Sentry.logger.info(
				"Reaction added",
				flatten({
					emoji: react.emoji.name,
					message: { id: react.message.id },
					user: {
						id: user.id,
						name: user.displayName,
						bot: user.bot,
					},
				}),
			),
	} satisfies EventDescriptor<"messageReactionAdd">,
	"reaction:delete": {
		discordJsName: "messageReactionRemove",
		spanName: "reaction removed",
		attributes: (react, user) => ({
			"discord.message.id": react.message.id,
			"discord.user.id": user.id,
		}),
		logger: (react, user) =>
			Sentry.logger.info(
				"Reaction removed",
				flatten({
					emoji: react.emoji.name,
					message: { id: react.message.id },
					user: {
						id: user.id,
						name: user.displayName,
						bot: user.bot,
					},
				}),
			),
	} satisfies EventDescriptor<"messageReactionRemove">,
} as const satisfies Record<string, unknown>;

// Maps our event names to the type of the data for that event
export type Events = {
	[K in keyof typeof events]: ClientEvents[(typeof events)[K]["discordJsName"]];
};

type EventHandler<K extends keyof Events> = (...data: Events[K]) => Promise<void>;

export class DiscordService extends Feature {
	readonly client: Client<true>;
	private handlers: {
		[K in keyof Events]?: EventHandler<K>[];
	} = {};

	/**
	 * Private constructor, used to construct class once ready client is created.
	 * Use {@link DiscordService.new()} to create a new DiscordService.
	 */
	private constructor(env: EnvService, client: Client<true>) {
		super(env);
		this.client = client;
		Sentry.logger.info(`${this._name} created`);
	}

	/**
	 * Constructs a new DiscordService
	 */
	static async new(env: EnvService): Promise<DiscordService> {
		return Sentry.startSpan({ name: "DiscordService.new", op: "function" }, async () => {
			const client = new Client({
				intents: [
					GatewayIntentBits.GuildMessageReactions,
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.GuildMembers,
					GatewayIntentBits.MessageContent,
					GatewayIntentBits.DirectMessages,
				],
				partials: [Partials.Reaction, Partials.Message, Partials.Channel],
			});
			const readyClient = new Promise<Client<true>>((resolve) => {
				client.once("clientReady", resolve);
			});
			client.login(env.vars.DISCORD_BOT_TOKEN);
			const ds = new DiscordService(env, await readyClient);
			Sentry.logger.info("Discord client connected");
			await ds.#initialSetup();
			return ds;
		});
	}

	/**
	 * Registers a single Discord event with a root Sentry span and fan-out to
	 * all subscribers. Extracted so TypeScript can reason about K at a time
	 * rather than across the whole union.
	 */
	#registerEvent<K extends keyof ClientEvents>(ourName: string, descriptor: EventDescriptor<K>) {
		this.client.on(descriptor.discordJsName, (...d: ClientEvents[K]) => {
			let attributes: SpanAttributes | undefined = undefined;
			try {
				attributes = descriptor.attributes?.(...d);
			} catch (e) {
				Sentry.captureException(e);
			}
			Sentry.startSpan(
				{
					parentSpan: null,
					name: descriptor.spanName,
					op: "discord.event",
					attributes,
				},
				async () => {
					try {
						descriptor.logger(...d);
					} catch (e) {
						Sentry.captureException(e);
					}
					const handlers = this.handlers[ourName as keyof Events] ?? [];
					await Promise.allSettled(
						handlers.map((handler) =>
							Sentry.withIsolationScope(() =>
								// Safe by construction: ourName and descriptor come from
								// the same events entry, but TypeScript can't prove it.
								(handler as (...args: ClientEvents[K]) => Promise<void>)(...d),
							),
						),
					);
				},
			);
		});
	}

	/**
	 * Initial client setup that happens in the background after logging in to the Discord Gateway.
	 */
	@traced()
	async #initialSetup() {
		// Set status to "watching you"
		this.client.user.setActivity({
			type: ActivityType.Watching,
			name: "you",
		});

		// Establish event handlers
		for (const [ourName, descriptor] of Object.entries(events)) {
			this.#registerEvent(ourName, descriptor as EventDescriptor<any>);
			Sentry.logger.info(Sentry.logger.fmt`Registered event handler for ${ourName}`);
		}

		// Remove all registered commands
		await Promise.all(
			this.client.guilds.cache.values().map(async (guild) => {
				await guild.commands.set([]);
				Sentry.logger.info("Removed commands from guild", {
					"guild.id": guild.id,
				});
			}),
		);
	}

	/**
	 * Subscribe to a Discord event. The handler runs inside a Sentry isolation
	 * scope and child span of the event's root span.
	 * @returns a function which when called, unsubscribes this handler
	 */
	subscribe<K extends keyof Events>(key: K, handler: EventHandler<K>): () => void {
		const list = (this.handlers[key] ??= []) as EventHandler<K>[];
		list.push(handler);
		return () => {
			const idx = list.indexOf(handler);
			if (idx !== -1) list.splice(idx, 1);
		};
	}

	@traced()
	async registerSlashCommand(
		command: JSONEncodable<RESTPostAPIChatInputApplicationCommandsJSONBody>,
		handler: (interaction: ChatInputCommandInteraction) => Promise<void>,
	) {
		const commandName = command.toJSON().name;
		// Register command in all guilds
		await Promise.all(
			this.client.guilds.cache.values().map(async (guild) => {
				const metadata = {
					"command.name": command.toJSON().name,
					"guild.id": guild.id,
					"guild.name": guild.name,
				};
				try {
					await guild.commands.create(command);
					Sentry.logger.info("Registered command with guild", metadata);
				} catch (e) {
					Sentry.captureException(e);
					Sentry.logger.error("Failed to register command", metadata);
				}
			}),
		);
		// Create interaction handler
		this.client.on("interactionCreate", async (interaction) => {
			Sentry.startSpan(
				{
					parentSpan: null,
					name: "interaction created",
					op: "discord.event",
					attributes: {
						"interaction.id": interaction.id,
						"interaction.type": InteractionType[interaction.type],
					},
				},
				async () => {
					if (
						interaction.isChatInputCommand() &&
						interaction.commandName == commandName
					) {
						return Sentry.withIsolationScope(() => handler(interaction));
					}
				},
			);
		});
	}

	@traced()
	async sendDM(userRef: UserResolvable, data: string | MessagePayload | MessageCreateOptions) {
		const user = await this.client.users.fetch(userRef);
		const dm = await user.createDM();
		await dm.send(data);
	}

	@traced()
	async stop() {
		await this.client.destroy();
		Sentry.logger.info("Discord client disconnected");
	}
}
