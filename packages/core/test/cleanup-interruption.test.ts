import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Ref, Schema } from "effect"
import { Graft, Plugin, Fork } from "../src/index.ts"

for (const mode of ["self", "worker"]) {
	it.effect(
		`reports a finalizer's ${mode} interruption on repeated disposal`,
		() =>
			Effect.gen(function* () {
				const completed = yield* Ref.make(false)
				const independent = yield* Ref.make(false)
				yield* Effect.gen(function* () {
					const fork = yield* Graft.plugin(
						Plugin.make({
							name: "interrupted cleanup",
							apply: () =>
								Effect.gen(function* () {
									const worker = yield* Plugin.fork(Effect.never)
									yield* Effect.addFinalizer(() => Ref.set(independent, true))
									yield* Effect.addFinalizer(() =>
										(mode === "self"
											? Effect.interrupt
											: Fiber.join(worker)
										).pipe(Effect.andThen(Ref.set(completed, true))),
									)
								}),
						}),
					)
					yield* fork.await
					for (const attempt of [1, 2]) {
						const result = yield* Effect.result(fork.dispose)
						assert(
							result._tag === "Failure",
							`dispose ${attempt} must report unfinished cleanup`,
						)
						assert.strictEqual(result.failure._tag, "CleanupError")
						assert.isTrue(Cause.hasInterruptsOnly(result.failure.cause))
					}
				}).pipe(Effect.scoped, Effect.provide(Graft.layer))
				const finished = yield* Ref.get(completed)
				assert.isFalse(finished)
				const otherReleased = yield* Ref.get(independent)
				assert.isTrue(otherReleased)
			}),
	)
}

it.effect("reports an interrupted finalizer when its owner scope closes", () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "automatic cleanup interruption",
					apply: () => Effect.addFinalizer(() => Effect.interrupt),
				}),
			)
			yield* fork.await
		}).pipe(Effect.scoped, Effect.provide(Graft.layer), Effect.exit)
		assert(Exit.isFailure(result))
		const error = Cause.squash(result.cause)
		assert(Schema.is(Fork.CleanupError)(error))
		assert.isTrue(Cause.hasInterruptsOnly(error.cause))
	}),
)
