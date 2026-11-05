/**
 * Event handlers that belong to a plugin.
 *
 * A plugin registers a handler with `Event.on`. When the plugin stops, Graft
 * removes the handler for it: there is no unsubscribe code to write or forget.
 */
import { Effect, Layer, Logger, String } from "effect"
import { NodeRuntime } from "@effect/platform-node"

import { Event, Graft, Plugin } from "@graftland/graft"

// An event is a typed name. Handlers of this one receive a string.
export const Message = Event.make<[text: string]>(
	"@graftland/sample-events/Message",
)

export const printer = Plugin.make({
	name: "printer",
	apply: () => Event.on(Message, (text) => Effect.log(`printer: ${text}`)),
})

export const shouter = Plugin.make({
	name: "shouter",
	apply: () =>
		Event.on(Message, (text) =>
			Effect.log(`shouter: ${String.toUpperCase(text)}!`),
		),
})

const program = Effect.gen(function* () {
	const printerFork = yield* Graft.plugin(printer)
	const shouterFork = yield* Graft.plugin(shouter)
	yield* printerFork.await
	yield* shouterFork.await

	yield* Effect.log("Sending a message to both plugins.")
	yield* Event.emit(Message, "hello")

	yield* Effect.log("Unloading shouter, then sending another message.")
	yield* shouterFork.dispose
	yield* Event.emit(Message, "anyone there?")
})

// Run the program with Graft's runtime when this file is executed directly,
// printing logs in a readable format.
if (import.meta.main)
	program.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(Graft.layer, Logger.layer([Logger.consolePretty()])),
		),
		NodeRuntime.runMain,
	)
