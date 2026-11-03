/**
 * One plugin publishes a service; another uses it.
 *
 * The plugin that uses a service declares it in `inject`. Graft starts that
 * plugin only once the service exists, and stops it before the service goes
 * away, so its code never has to check.
 */
import { NodeRuntime } from "@effect/platform-node"
import { type Fork, Graft, Plugin } from "@graftland/graft"
import { Context, Effect, Layer, Logger, Stream } from "effect"

// A service is an ordinary Effect service key.
export class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("@graftland/sample-services/main/Greeter") {}

// Two plugins that publish a Greeter, each while it is loaded.
export const english = Plugin.make({
	name: "english",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.log(`Hello, ${name}!`),
		}),
})

export const french = Plugin.make({
	name: "french",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.log(`Bonjour, ${name} !`),
		}),
})

// Uses whichever Greeter exists.
export const welcome = Plugin.make({
	name: "welcome",
	inject: [Greeter],
	apply: () =>
		Effect.gen(function* () {
			const greeter = yield* Greeter
			yield* greeter.greet("world")
			yield* Effect.addFinalizer(() => Effect.log("welcome stopped"))
		}),
})

// Waits until a fork is running. `fork.await` returns earlier: as soon as the
// fork is waiting for a service, it counts as settled.
const running = (fork: Fork.Fork) =>
	Stream.runHead(Stream.filter(fork.state, (state) => state._tag === "Active"))

const program = Effect.gen(function* () {
	yield* Effect.log("Loading welcome. No Greeter exists yet, so it waits.")
	const welcomeFork = yield* Graft.plugin(welcome)
	yield* welcomeFork.await

	yield* Effect.log("Loading english. welcome starts on its own.")
	const englishFork = yield* Graft.plugin(english)
	yield* running(welcomeFork)

	yield* Effect.log("Unloading english. welcome stops first, then waits again.")
	yield* englishFork.dispose

	yield* Effect.log(
		"Loading french. welcome starts again, with the new Greeter.",
	)
	yield* Graft.plugin(french)
	yield* running(welcomeFork)
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
