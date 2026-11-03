import { assert, describe, it } from "@effect/vitest"
import { Cause, Schema, Deferred, Effect, Exit, Fiber, TxRef } from "effect"
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
				).pipe(Effect.forkScoped)
				yield* Effect.yieldNow
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
