/**
 * Your first plugin.
 *
 * A plugin describes how to start something. Graft starts it, restarts it
 * when its config changes, and stops it, running its cleanup each time.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import { Effect, Layer, Logger, Schema } from "effect"

export const greeter = Plugin.make({
	name: "greeter",
	// The plugin's config. Graft checks every config against this schema.
	config: Schema.Struct({ name: Schema.String }),
	// Runs when the plugin starts. `acquireRelease` pairs a start action with
	// a cleanup action; Graft runs the cleanup when the plugin stops.
	apply: ({ name }) =>
		Effect.acquireRelease(Effect.log(`Hello, ${name}!`), () =>
			Effect.log(`Goodbye, ${name}!`),
		),
})

const program = Effect.gen(function* () {
	// Load the plugin. The running instance is called a fork.
	const fork = yield* Graft.plugin(greeter, { name: "Alice" })
	yield* fork.await

	// Give it a new config: the old instance stops, a new one starts.
	yield* fork.update({ name: "Bob" })
	yield* fork.await

	// Unload it: its cleanup runs.
	yield* fork.dispose
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
