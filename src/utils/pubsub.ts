import { EventEmitter } from "node:events";
import * as Sentry from "@sentry/bun";
import type { SerializedTraceData } from "@sentry/core";

/**
 * Pub/Sub provider.
 *
 * The type parameter is a map of events that this pub/sub can process.
 */
export class PubSub<EM extends Record<string, unknown[]> = never> {
	subscriber: Subscriber<EM>;
	publisher: Publisher<EM>;

	constructor() {
		const emitter = new EventEmitter();
		this.subscriber = new Subscriber(emitter);
		this.publisher = new Publisher(emitter);
	}
}

export class Subscriber<EM extends Record<string, unknown[]>> {
	private emitter: EventEmitter;

	constructor(emitter: EventEmitter) {
		this.emitter = emitter;
	}

	/**
	 * Subscribe to an event
	 * @param key event to subscribe to
	 * @param fn callback to execute with event data
	 * @returns a function which when called, unsubscribes this event handler
	 */
	subscribe<K extends keyof EM & string>(key: K, fn: (...data: EM[K]) => void) {
		const cb = ([traceData, data]: [SerializedTraceData, EM[K]]) => {
			// Continue the span that emitted the event
			Sentry.continueTrace(
				{
					sentryTrace: traceData["sentry-trace"],
					baggage: traceData.baggage,
				},
				() => {
					Sentry.startSpan(
						{
							name: "consume event",
							op: "queue.process",
							attributes: {
								"messaging.message.id": key,
							},
						},
						(span) => {
							fn(...data);
						},
					);
				},
			);
		};
		this.emitter.on(key, cb);
		return () => {
			this.emitter.off(key, cb);
		};
	}

	/**
	 * Subscribe to the next event for the given key.
	 * The callback will be executed at most one time.
	 * @param key event key to subscribe to
	 * @param fn callback to execute with event data
	 * @returns a function which when called, unsubscribes this event handler
	 */
	once<K extends keyof EM & string>(key: K, fn: (...data: EM[K]) => void) {
		const cb = ([traceData, data]: [SerializedTraceData, EM[K]]) => {
			// Continue the span that emitted the event
			Sentry.continueTrace(
				{
					sentryTrace: traceData["sentry-trace"],
					baggage: traceData.baggage,
				},
				() => {
					fn(...data);
				},
			);
		};
		this.emitter.on(key, cb);
		return () => {
			this.emitter.off(key, cb);
		};
	}

	/**
	 * Wait for the next event
	 * @param key event to wait for
	 * @returns a Promise that resolves with the event data
	 */
	waitFor<K extends keyof EM & string>(key: K): Promise<EM[K]> {
		return new Promise((resolve) => {
			this.once(key, (...data) => resolve(data));
		});
	}
}

export class Publisher<EM extends Record<string, unknown[]>> {
	private emitter: EventEmitter;

	constructor(emitter: EventEmitter) {
		this.emitter = emitter;
	}

	/**
	 * Publishes an event
	 * @param key event key
	 * @param data event data
	 */
	publish<K extends keyof EM & string>(key: K, ...data: EM[K]) {
		// Include span information so we can continue the trace
		const traceData = Sentry.getTraceData();
		Sentry.startSpan(
			{
				name: "publish event",
				op: "queue.publish",
				attributes: {
					"messaging.destination.name": key,
				},
			},
			() => {
				this.emitter.emit(key, [traceData, data]);
			},
		);
	}
}
