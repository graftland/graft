import { Effect, Schedule, Schema } from "effect"

import { Plugin } from "@graftland/graft"

import { Greeter } from "./greeter.ts"

// Starts once a Greeter exists and greets on a schedule. The task belongs to
// the plugin, so it stops when the plugin stops or reloads.
export default Plugin.make({
	name: "{{package}}/ticker",
	config: Schema.Struct({ name: Schema.String }),
	inject: [Greeter],
	apply: ({ name }) =>
		Effect.gen(function* () {
			const greeter = yield* Greeter
			yield* Plugin.fork(
				greeter.greet(name).pipe(Effect.repeat(Schedule.spaced("3 seconds"))),
			)
			yield* Effect.addFinalizer(() => Effect.logInfo("Ticker stopped"))
		}),
})
