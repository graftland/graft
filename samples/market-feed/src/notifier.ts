import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Notifier } from "./services.ts"

export const notifier = Plugin.make({
	name: "@graftland/sample-market-feed/notifier",
	apply: Effect.fn("notifier.apply")(function* () {
		yield* Effect.addFinalizer(() => Effect.log("notifier: stopped"))
		yield* Graft.provide(Notifier, {
			send: (message) => Effect.log(`webhook: ${message}`),
		})
		yield* Effect.log("notifier: started (simulated Slack webhook)")
	}),
})
