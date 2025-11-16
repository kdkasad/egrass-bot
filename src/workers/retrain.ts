// Worker to retrain Markov model.
// Runs in a separate JS runtime spawned via a Worker.

import {
	clearMarkovModel,
	doInTransaction,
	getAllMessages,
	vacuum,
} from "../db";
import { addMessageToMarkov4 } from "../markov";

declare const self: Worker;

// Wait for initial message with list of bot user IDs
self.addEventListener(
	"message",
	(event) => {
		const botUserIds = event.data as Set<string>;

		// Do retraining
		let count = 0;
		doInTransaction(() => {
			clearMarkovModel();
			for (const message of getAllMessages()) {
				if (botUserIds.has(message.author_id)) continue;
				addMessageToMarkov4(message, message.author_id);

				// Every 100 messages processed, send a progress update
				count += 1;
				if (count % 100 === 0) {
					self.postMessage(count);
				}
			}
		})();
		vacuum();
	},
	{ once: true },
);
