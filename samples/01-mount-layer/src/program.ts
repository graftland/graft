/**
 * Mount a layer.
 *
 * Graft builds the layer when everything it requires is available, publishes
 * the services the layer provides, and releases the layer when the mount is
 * torn down. The mount belongs to the current scope.
 */
import { Context, Effect, Layer, type Scope } from "effect"

import { Graft, Mount } from "@graftland/graft"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => string }
>()("@graftland-samples/01-mount-layer/program/Greeter") {}

const greeter = Layer.effect(
	Greeter,
	Effect.acquireRelease(
		Effect.log("Building the greeter").pipe(
			Effect.as({ greet: (name: string) => `Hello, ${name}!` }),
		),
		() => Effect.log("Releasing the greeter"),
	),
)

export const program: Effect.Effect<
	void,
	Graft.ServiceConflict | Graft.ServiceWithdrawn | Mount.CleanupError,
	Graft.Graft | Scope.Scope
> = Effect.gen(function* () {
	const mount = yield* Graft.mount(greeter, { name: "greeter" })
	yield* mount.await

	yield* Graft.use(Greeter, (service) => Effect.log(service.greet("world")))

	// Closing the scope would do this too. Unmounting here shows the release.
	yield* mount.unmount
})
