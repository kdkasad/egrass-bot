import {
	GatewayIntentBits,
	Partials,
	Client,
	ActivityType,
	type ClientEvents,
	ChannelType,
} from "discord.js";
import * as Sentry from "@sentry/bun";
import { Feature } from "../utils/service";
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
		spanName: "Message created",
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
} as const satisfies Record<string, unknown>;

// Maps our event names to the type of the data for that event
export type Events = {
	[K in keyof typeof events]: ClientEvents[(typeof events)[K]["discordJsName"]];
};

type EventHandler<K extends keyof Events> = (...data: Events[K]) => Promise<void>;

export class DiscordService extends Feature {
	private client: Client<true>;
	private handlers: {
		[K in keyof Events]?: EventHandler<K>[];
	} = {};

	/**
	 * Private constructor, used to construct class once ready client is created.
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
			ds.initialSetup(); // start in background
			return ds;
		});
	}

	/**
	 * Initial client setup that happens in the background after logging in to the Discord Gateway.
	 */
	private async initialSetup() {
		return Sentry.startSpan(
			{ name: "DiscordService.initialSetup", op: "function" },
			async () => {
				// Set status to "watching you"
				this.client.user.setActivity({
					type: ActivityType.Watching,
					name: "you",
				});

				// Establish event handlers
				for (const [ourName, descriptor] of Object.entries(events)) {
					this.client.on(descriptor.discordJsName, (...d) => {
						Sentry.startSpan(
							{
								parentSpan: null,
								name: descriptor.spanName,
								op: "discord.event",
								attributes: descriptor.attributes(...d),
							},
							async () => {
								// Log the event
								descriptor.logger(...d);
								// Get the subscriber handlers
								const handlers = this.handlers[ourName as keyof Events] ?? [];
								await Promise.all(
									handlers.map((handler) =>
										Sentry.withIsolationScope(() => {
											return handler(...d);
										}),
									),
								);
							},
						);
					});
					Sentry.logger.info(Sentry.logger.fmt`Registered event handler for ${ourName}`);
				}
			},
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

	async stop() {
		return Sentry.startSpan({ name: "DiscordService.stop", op: "function" }, async () => {
			await this.client.destroy();
			Sentry.logger.info("Discord client disconnected");
		});
	}
}
