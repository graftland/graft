import { Cause, Deferred, Effect, Exit, Fiber, Schema, TxRef } from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Release from "@graftland/graft/Release"
import { ReleaseInterrupted } from "@graftland/graft/Release"

import * as FailureGroup from "../src/internal/FailureGroup"

class Failed extends Schema.TaggedError<
	Failed,
	{ readonly brand: unique symbol }
>()("Failed", { detail: Schema.String }) {}

describe("failure group", () => {
	it.effect("publishes the first failure and interrupts owned siblings", () =>
		Effect.gen(function* () {
			const group = yield* FailureGroup.make<Failed>()
			const started = yield* Deferred.make<void>()
			const stopped = yield* Deferred.make<void>()
			yield* group.run(
				Deferred.succeed(started, undefined).pipe(
					Effect.andThen(Effect.never),
					Effect.ensuring(Deferred.succeed(stopped, undefined)),
				),
			)
			yield* Deferred.await(started)
			const error = Failed.make({ detail: "first" })
			yield* group.run(Effect.fail(error))
			const failure = yield* Effect.flip(group.await)
			assert.strictEqual(failure, error)
			yield* Deferred.await(stopped)
			yield* group.fail(Failed.make({ detail: "later" }))
			const retained = yield* Effect.flip(group.check)
			assert.strictEqual(retained, error)
		}).pipe(Effect.scoped),
	)
	it.effect(
		"wakes transactional admission when an external failure arrives",
		() =>
			Effect.gen(function* () {
				const group = yield* FailureGroup.make<Failed>()
				const capacity = yield* TxRef.make(0)
				const waiting = yield* Effect.tx(
					group.check.pipe(
						Effect.andThen(TxRef.get(capacity)),
						Effect.andThen(Effect.txRetry),
					),
				).pipe(Effect.forkScoped({ startImmediately: true }))
				const error = Failed.make({ detail: "disconnected" })
				yield* group.fail(error)
				const failure = yield* Effect.flip(Fiber.join(waiting))
				assert.strictEqual(failure, error)
			}).pipe(Effect.scoped),
	)
	it.effect("closes by interruption without inventing a failure", () =>
		Effect.gen(function* () {
			const group = yield* FailureGroup.make<Failed>()
			const waiting = yield* group.run(Effect.never)
			yield* group.close
			const exit = yield* Fiber.await(waiting)
			assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
			const cause = yield* group.cause
			assert.equal(cause.reasons.length, 0)
			const later = yield* group.run(Effect.void)
			const laterExit = yield* Fiber.await(later)
			assert.isTrue(
				Exit.isFailure(laterExit) && Cause.hasInterruptsOnly(laterExit.cause),
			)
		}).pipe(Effect.scoped),
	)
})

it.effect("hands off worker cleanup failure on active close", () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const group = yield* FailureGroup.make<never>()
			const ready = yield* Deferred.make<void>()
			yield* group.run(
				Deferred.succeed(ready, undefined).pipe(
					Effect.andThen(Effect.never),
					Effect.ensuring(Effect.die("cleanup marker")),
				),
			)
			yield* Deferred.await(ready)
			const closed = yield* Effect.exit(group.close)
			assert(Exit.isFailure(closed))
			assert.include(Cause.pretty(closed.cause), "cleanup marker")
			const cause = yield* group.cause
			assert.include(Cause.pretty(cause), "cleanup marker")
		}).pipe(Effect.scoped, Effect.exit)
		assert(Exit.isFailure(result))
		assert.include(Cause.pretty(result.cause), "cleanup marker")
	}),
)

for (const cancelled of [false, true]) {
	it.effect(
		`retains nested scope cleanup interruption with cancellation ${cancelled}`,
		() =>
			Effect.gen(function* () {
				const exit = yield* Effect.gen(function* () {
					const group = yield* FailureGroup.make<never>()
					const ready = yield* Deferred.make<void>()
					const worker = yield* group.run(
						Effect.scoped(
							Effect.addFinalizer(() => Effect.interrupt).pipe(
								Effect.andThen(Deferred.succeed(ready, undefined)),
								Effect.andThen(cancelled ? Effect.never : Effect.void),
							),
						),
					)
					yield* Deferred.await(ready)
					if (!cancelled) yield* Fiber.await(worker)
					const closed = yield* Effect.exit(group.close)
					assert(Exit.isFailure(closed))
					assert.isTrue(Cause.hasInterruptsOnly(closed.cause))
				}).pipe(Effect.scoped, Effect.exit)
				assert(Exit.isFailure(exit))
				assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
			}),
	)
}

it.effect("retains explicitly reported interruption as a failure", () =>
	Effect.gen(function* () {
		const exit = yield* Effect.gen(function* () {
			const group = yield* FailureGroup.make<never>()
			yield* group.failCause(Cause.interrupt(123))
			const failure = yield* Effect.exit(
				group.await.pipe(Effect.timeout("1 second")),
			)
			assert(Exit.isFailure(failure))
			assert.isTrue(Cause.hasInterruptsOnly(failure.cause))
		}).pipe(Effect.scoped, Effect.exit)
		assert(Exit.isFailure(exit))
		assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
	}),
)

for (const nested of [false, true]) {
	for (const cancelled of [false, true]) {
		it.effect(
			`preserves release defects through ${nested ? "nested" : "direct"} groups with cancellation ${cancelled}`,
			() =>
				Effect.gen(function* () {
					const exit = yield* Effect.gen(function* () {
						const group = yield* FailureGroup.make<never>()
						const ready = yield* Deferred.make<void>()
						const work = Effect.addFinalizer(() => Effect.interrupt).pipe(
							Effect.andThen(Deferred.succeed(ready, undefined)),
							Effect.andThen(cancelled ? Effect.never : Effect.void),
						)
						const worker = yield* group.run(
							nested
								? Effect.scoped(
										Effect.gen(function* () {
											const inner = yield* FailureGroup.make<never>()
											const child = yield* inner.run(work)
											return yield* Fiber.join(child)
										}),
									)
								: work,
						)
						yield* Deferred.await(ready)
						if (!cancelled) yield* Fiber.await(worker)
						const closed = yield* Effect.exit(group.close)
						assert(Exit.isFailure(closed))
						const release = Cause.squash(closed.cause)
						assert(Schema.is(ReleaseInterrupted)(release))
						assert.isTrue(Cause.hasInterruptsOnly(release.cause))
					}).pipe(Effect.scoped, Effect.exit)
					assert(Exit.isFailure(exit))
					assert(Schema.is(ReleaseInterrupted)(Cause.squash(exit.cause)))
				}),
		)
	}
}

for (const finalizer of ["masked", "interruptible", "self", "die"]) {
	it.effect(
		`classifies ${finalizer} release when a scoped failure group closes`,
		() =>
			Effect.gen(function* () {
				const defect = new Error("worker release failed")
				const cleanup =
					finalizer === "masked"
						? Effect.void
						: finalizer === "interruptible"
							? Effect.interruptible(Effect.void)
							: finalizer === "self"
								? Effect.interrupt
								: Effect.die(defect)
				const result = yield* Effect.gen(function* () {
					const group = yield* FailureGroup.make<never>()
					const ready = yield* Deferred.make<void>()
					const worker = yield* group.run(
						Effect.addFinalizer(() => cleanup).pipe(
							Effect.andThen(Deferred.succeed(ready, undefined)),
							Effect.andThen(Effect.never),
						),
					)
					yield* Deferred.await(ready)
					const closed = yield* Effect.exit(group.close)
					const cause = yield* group.cause
					const stopped = yield* Fiber.await(worker)
					assert(Exit.isFailure(stopped))
					if (finalizer === "masked" || finalizer === "interruptible") {
						assert.deepStrictEqual(closed, Exit.void)
						assert.deepStrictEqual(cause, Cause.empty)
						assert.isTrue(Cause.hasInterruptsOnly(stopped.cause))
					} else {
						assert(Exit.isFailure(closed))
						assert.deepStrictEqual(cause, closed.cause)
						const released = Cause.squash(closed.cause)
						if (finalizer === "self") {
							assert(Schema.is(ReleaseInterrupted)(released))
							assert.isTrue(Cause.hasInterruptsOnly(released.cause))
						} else assert.strictEqual(released, defect)
					}
				}).pipe(Release.scoped, Effect.exit)
				if (finalizer === "masked" || finalizer === "interruptible")
					assert.deepStrictEqual(result, Exit.void)
				else {
					assert(Exit.isFailure(result))
					const released = Cause.squash(result.cause)
					if (finalizer === "self")
						assert(Schema.is(ReleaseInterrupted)(released))
					else assert.strictEqual(released, defect)
				}
			}),
	)
}
