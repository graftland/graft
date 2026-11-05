import { Cause, Deferred, Effect, Exit, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Event } from "../src/index.ts"
import { run } from "./utils.ts"

describe("parallel dispatch cancellation", () => {
	for (const mode of ["failure", "defect"] as const) {
		it.effect(
			`preserves a completed ${mode} and cleanup defects when cancelled`,
			() =>
				Effect.gen(function* () {
					const event = Event.make<[], void, string>("cancelled-parallel")
					const failed = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
					const entered = yield* Deferred.make<void>()
					const cleaning = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					yield* Event.on(event, () =>
						Effect.withFiber((fiber) =>
							Deferred.succeed(failed, fiber).pipe(
								Effect.andThen(
									mode === "failure"
										? Effect.fail("completed handler failure")
										: Effect.die("completed handler failure"),
								),
							),
						),
					)
					yield* Event.on(event, () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								Deferred.succeed(cleaning, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.andThen(Effect.die("handler cleanup defect")),
								),
							),
						),
					)
					const dispatch = yield* Effect.forkScoped(Event.parallel(event))
					yield* Deferred.await(entered)
					const failedFiber = yield* Deferred.await(failed)
					const original = yield* Fiber.await(failedFiber)
					assert.isTrue(Exit.isFailure(original))
					yield* TestClock.adjust("1 millis")
					const cancelling = yield* Effect.forkScoped(Fiber.interrupt(dispatch))
					yield* Deferred.await(cleaning)
					yield* TestClock.adjust("1 millis")
					const premature = dispatch.pollUnsafe() !== undefined
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(cancelling)
					const result = yield* Fiber.await(dispatch)
					assert.isFalse(premature)
					assert.isTrue(Exit.isFailure(result))
					if (Exit.isFailure(result)) {
						assert.isTrue(Cause.hasInterrupts(result.cause))
						assert.include(
							Cause.pretty(result.cause),
							"completed handler failure",
						)
						assert.include(Cause.pretty(result.cause), "handler cleanup defect")
					}
				}).pipe(run),
		)
	}

	it.effect(
		"waits for every handler after a failure and aggregates failures without duplication",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[], void, string>("parallel-failure-order")
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const finished = yield* Ref.make(false)
				yield* Event.on(event, () => Effect.fail("first"))
				yield* Event.on(event, () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(Ref.set(finished, true)),
						Effect.andThen(Effect.fail("second")),
					),
				)
				const dispatch = yield* Effect.forkScoped(Event.parallel(event))
				yield* Deferred.await(entered)
				assert.isUndefined(dispatch.pollUnsafe())
				yield* Deferred.succeed(release, undefined)
				const result = yield* Fiber.await(dispatch)
				const completed = yield* Ref.get(finished)
				assert.isTrue(completed)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					assert.strictEqual(result.cause.reasons.length, 2)
					assert.include(Cause.pretty(result.cause), "first")
					assert.include(Cause.pretty(result.cause), "second")
				}
			}).pipe(run),
	)
})
