import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

/** Greets by name. Other plugins list it in `inject` to use it. */
export class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("{{package}}/greeter") {}

// Publishes a Greeter while it is loaded. Plugins that use it stop first.
export default Plugin.make({
	name: "{{package}}/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	provides: [Greeter],
	apply: ({ greeting }) =>
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() => Effect.logInfo("Greeter stopped"))
			yield* Graft.provide(Greeter, {
				greet: (name) => Effect.logInfo(`${greeting}, ${name}!`),
			})
		}),
})
