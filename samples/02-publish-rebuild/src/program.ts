/**
 * Publish a value and rebuild a mount when it changes.
 *
 * `Graft.publish` puts a value in the graph as a Publication. A mount that
 * requires it is built with the value in scope. Changing the value makes Graft
 * tear the mount down and build it again.
 */
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, { readonly text: string }>()(
	"@graftland-samples/02-publish-rebuild/program/Greeting",
) {}

class Config extends Context.Service<Config, { readonly greeting: string }>()(
	"@graftland-samples/02-publish-rebuild/program/Config",
) {}

const greeter = Layer.effect(
	Greeting,
	Effect.gen(function* () {
		const config = yield* Config
		yield* Effect.log(`Building the greeter with "${config.greeting}"`)
		return yield* Effect.acquireRelease(
			Effect.succeed({ text: config.greeting }),
			() => Effect.log(`Releasing the greeter for "${config.greeting}"`),
		)
	}),
)

export const program = Effect.gen(function* () {
	const config = yield* Graft.publish(Config, { greeting: "Hello" })
	// Publishing is applied by the graph's supervisor, so wait until the value
	// is really available before mounting something that requires it.
	yield* config.await

	// `requires` tells the graph what the layer needs. The layer is built only
	// while every required value is available.
	const mount = yield* Graft.mount(greeter, {
		name: "greeter",
		requires: [Config],
	})
	yield* mount.await

	yield* Graft.use(Greeting, (service) => Effect.log(`${service.text}, world!`))

	// `set` replaces the value. The mount is rebuilt with the new one.
	yield* config.set({ greeting: "Hi" })
	yield* mount.stable

	yield* Graft.use(Greeting, (service) => Effect.log(`${service.text}, again!`))
})
