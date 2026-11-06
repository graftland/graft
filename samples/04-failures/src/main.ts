/**
 * Failures and retries.
 *
 * When a plugin fails, Graft cleans it up, logs the error, and tries again on
 * the plugin's `retry` schedule. Other plugins keep running.
 */
import { Effect, Layer, Logger, Ref, Schedule, Schema, Stream } from "effect"
import { NodeRuntime } from "@effect/platform-node"

import { Graft, Plugin, type Fork } from "@graftland/graft"

export class ConnectionRefused extends Schema.TaggedError<
	ConnectionRefused,
	{ readonly brand: unique symbol }
>()("ConnectionRefused", { attempt: Schema.Int }) {
	override get message(): string {
		return `Connection refused on attempt ${this.attempt}`
	}
}

// A client for a server that refuses the first two connections. `attempts`
// counts connections across restarts, so it is created outside the plugin.
export const makeClient = (attempts: Ref.Ref<number>) =>
	Plugin.make({
		name: "@graftland/sample-failures/main/makeClient",
		// Try again 300 ms after each failure.
		retry: Schedule.spaced("300 millis"),
		apply: Effect.fn("client.apply")(function* () {
			const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
			yield* Effect.log(`Connecting, attempt ${attempt}`)
			if (attempt < 3) return yield* ConnectionRefused.make({ attempt })
			yield* Effect.log("Connected")
		}),
	})

// Ticks in the background. `Plugin.fork` ties the task to the plugin: it
// stops when the plugin stops.
export const heartbeat = Plugin.make({
	name: "@graftland/sample-failures/main/heartbeat",
	apply: () =>
		Effect.log("heartbeat: still running").pipe(
			Effect.repeat(Schedule.spaced("250 millis")),
			Plugin.fork,
			Effect.asVoid,
		),
})

const running = (fork: Fork.Fork) =>
	Stream.runHead(Stream.filter(fork.state, (state) => state._tag === "Active"))

const program = Effect.gen(function* () {
	yield* Graft.plugin(heartbeat)
	const attempts = yield* Ref.make(0)
	const client = yield* Graft.plugin(makeClient(attempts))
	yield* running(client)
	yield* Effect.log("The client is running; unloading everything.")
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
