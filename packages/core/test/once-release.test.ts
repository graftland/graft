import { RuntimeContext } from "../src/internal/runtimeContext"
import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	Ref,
	Scope,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { Event } from "../src/index.ts"
import { run } from "./utils.ts"

// Inspect ownership directly: garbage-collection timing is not a reliable retention test.
const finalizers = (scope: Scope.Scope): number =>
	scope.state._tag === "Open"
		? (scope.state.finalizer === undefined ? 0 : 1) +
			(scope.state.finalizers?.size ?? 0)
		: 0

const ownerScope = Effect.acquireRelease(Scope.make(), (scope) =>
	Scope.close(scope, Exit.void),
)

describe("once registration release", () => {
	it.effect(
		"releases consumed registrations while keeping ordinary handlers registered",
		() =>
			Effect.gen(function* () {
				const owner = yield* ownerScope
				const event = Event.make<[]>("once-retention")
				yield* Event.on(event, () => Effect.void).pipe(Scope.provide(owner))
				const baseline = finalizers(owner)
				for (const _ of Array.range(1, 100)) {
					yield* Event.once(event, () => Effect.void).pipe(Scope.provide(owner))
					yield* Event.emit(event)
					assert.strictEqual(finalizers(owner), baseline)
				}
				const { runtime } = yield* RuntimeContext
				yield* Scope.close(owner, Exit.void)
				const events = yield* TxRef.get(runtime.events)
				assert.isFalse(HashMap.has(events, event.key))
			}).pipe(run),
	)

	for (const outcome of ["failure", "defect", "interruption"] as const) {
		it.effect(
			`releases a once registration after ${outcome} without changing its cause`,
			() =>
				Effect.gen(function* () {
					const owner = yield* ownerScope
					const event = Event.make<[], void, string>("failed-once")
					const handler =
						outcome === "failure"
							? Effect.fail("handler failure")
							: outcome === "defect"
								? Effect.die("handler defect")
								: Effect.interrupt
					yield* Event.once(event, () => handler).pipe(Scope.provide(owner))
					const result = yield* Effect.exit(Event.emit(event))
					assert.isTrue(Exit.isFailure(result))
					if (Exit.isFailure(result)) {
						assert.isTrue(
							outcome === "failure"
								? Cause.hasFails(result.cause)
								: outcome === "defect"
									? Cause.hasDies(result.cause)
									: Cause.hasInterruptsOnly(result.cause),
						)
					}
					assert.strictEqual(finalizers(owner), 0)
				}).pipe(run),
		)
	}

	it.effect(
		"retains a claimed handler until execution finishes despite competing dispatches",
		() =>
			Effect.gen(function* () {
				const owner = yield* ownerScope
				const event = Event.make<[], string>("running-once")
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				yield* Event.once(event, () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.as("answer"),
					),
				).pipe(Scope.provide(owner))
				const first = yield* Effect.forkScoped(Event.parallel(event))
				yield* Deferred.await(entered)
				const second = yield* Event.parallel(event)
				assert.deepStrictEqual(second, [])
				assert.isAbove(finalizers(owner), 0)
				yield* Deferred.succeed(release, undefined)
				const result = yield* Fiber.join(first)
				assert.deepStrictEqual(result, ["answer"])
				assert.strictEqual(finalizers(owner), 0)
			}).pipe(run),
	)

	it.effect(
		"keeps ownership through cancellation cleanup and preserves cleanup defects",
		() =>
			Effect.gen(function* () {
				const owner = yield* ownerScope
				const event = Event.make<[]>("cancelled-once")
				const entered = yield* Deferred.make<void>()
				const cleaning = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				yield* Event.once(event, () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(
							Deferred.succeed(cleaning, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(Effect.die("once cleanup defect")),
							),
						),
					),
				).pipe(Scope.provide(owner))
				const dispatch = yield* Effect.forkScoped(Event.emit(event))
				yield* Deferred.await(entered)
				const cancelling = yield* Effect.forkScoped(Fiber.interrupt(dispatch))
				yield* Deferred.await(cleaning)
				assert.isAbove(finalizers(owner), 0)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(cancelling)
				const result = yield* Fiber.await(dispatch)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.include(Cause.pretty(result.cause), "once cleanup defect")
				assert.strictEqual(finalizers(owner), 0)
			}).pipe(run),
	)
	for (const mode of ["bail", "waterfall"] as const) {
		it.effect(`releases a successful once registration after ${mode}`, () =>
			Effect.gen(function* () {
				const owner = yield* ownerScope
				if (mode === "bail") {
					const event = Event.make<[], Option.Option<string>>(
						"once-bail-release",
					)
					yield* Event.once(event, () => Effect.succeedSome("answer")).pipe(
						Scope.provide(owner),
					)
					const result = yield* Event.bail(event)
					assert.deepStrictEqual(result, Option.some("answer"))
				} else {
					const event = Event.middleware<string, string>(
						"once-waterfall-release",
					)
					yield* Event.once(event, (input, next) => next(input)).pipe(
						Scope.provide(owner),
					)
					const result = yield* Event.waterfall(event, "answer", Effect.succeed)
					assert.strictEqual(result, "answer")
				}
				assert.strictEqual(finalizers(owner), 0)
			}).pipe(run),
		)
	}

	for (const registration of ["on", "once"] as const) {
		it.effect(
			`waits for ${registration} cancellation cleanup before releasing owner resources`,
			() =>
				Effect.gen(function* () {
					const owner = yield* ownerScope
					const alive = yield* Ref.make(true)
					const observed = yield* Ref.make(false)
					yield* Scope.addFinalizer(owner, Ref.set(alive, false))
					const event = Event.make<[]>("owner-cleanup-order")
					const entered = yield* Deferred.make<void>()
					const cleaning = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					yield* Event[registration](event, () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								Deferred.succeed(cleaning, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.andThen(
										Effect.flatMap(Ref.get(alive), (value) =>
											Ref.set(observed, value),
										),
									),
								),
							),
						),
					).pipe(Scope.provide(owner))
					const dispatch = yield* Effect.forkScoped(Event.emit(event))
					yield* Deferred.await(entered)
					const closing = yield* Effect.forkScoped(
						Scope.close(owner, Exit.void),
					)
					yield* Deferred.await(cleaning)
					yield* TestClock.adjust("1 millis")
					const premature = closing.pollUnsafe() !== undefined
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(closing)
					yield* Fiber.join(dispatch)
					const wasAlive = yield* Ref.get(observed)
					assert.isFalse(premature)
					assert.isTrue(wasAlive)
				}).pipe(run),
		)
	}
})
