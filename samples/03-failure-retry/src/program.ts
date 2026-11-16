/**
 * Failure and retry.
 *
 * A mount that fails enters `Failed` with the complete cause. With a `retry`
 * schedule, Graft builds it again after each failure. The mount stays usable
 * either way: `await` resolves when it becomes active.
 */
import { Context, Effect, Layer, Ref, Schedule, Schema, Stream } from "effect"

import { Graft } from "@graftland/graft"

class Backend extends Context.Service<Backend, { readonly ready: true }>()(
	"@graftland-samples/03-failure-retry/program/Backend",
) {}

class NotReady extends Schema.TaggedError<
	NotReady,
	{ readonly brand: unique symbol }
>()("NotReady", { attempt: Schema.Finite }) {
	override get message() {
		return `The backend was not ready on attempt ${this.attempt}`
	}
}

export const program = Effect.gen(function* () {
	const attempts = yield* Ref.make(0)

	const backend = Layer.effect(
		Backend,
		Effect.acquireRelease(
			Effect.gen(function* () {
				const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
				yield* Effect.log(`Connecting (attempt ${attempt})`)
				// The first two builds fail, so Graft applies the retry schedule.
				if (attempt < 3) {
					yield* Effect.logWarning("The backend is not ready yet")
					return yield* NotReady.make({ attempt })
				}
				return { ready: true as const }
			}),
			() => Effect.log("Closing the backend"),
		),
	)

	const mount = yield* Graft.mount(backend, {
		name: "backend",
		retry: Schedule.recurs(3),
	})
	// A retrying mount passes through `Failed` between attempts. Wait for the
	// state that shows the retry worked.
	yield* mount.state.pipe(
		Stream.filter((state) => state._tag === "Active"),
		Stream.runHead,
	)

	yield* Effect.log("The mount is active")
	yield* Graft.use(Backend, (service) =>
		Effect.log(`Using the backend, ready: ${service.ready}`),
	)
})
