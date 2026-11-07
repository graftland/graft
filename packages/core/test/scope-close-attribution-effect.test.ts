import { Array, Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { assert, it } from "@effect/vitest"

import { observeClose } from "./scope-close-attribution-fixture.ts"

// This file and its fixture use only Effect; no Graft runtime or adapter is loaded.
for (const finalizer of [
	"masked",
	"interruptible",
	"self",
	"joined",
] as const) {
	it.effect(
		`observes raw ${finalizer} finalization separately from pending cancellation`,
		() =>
			Effect.gen(function* () {
				const result = yield* observeClose(Scope.close, finalizer)
				assert.deepStrictEqual(result.before, Exit.void)
				assert(Exit.isFailure(result.pending))
				assert.deepStrictEqual(
					Array.fromIterable(Cause.interruptors(result.pending.cause)),
					[result.canceller],
				)
				assert(Exit.isFailure(result.outer))
				assert.isTrue(Cause.hasInterruptsOnly(result.outer.cause))
				if (finalizer === "masked") {
					assert.deepStrictEqual(result.closed, Exit.void)
				} else {
					assert(Exit.isFailure(result.closed))
					assert.isTrue(Cause.hasInterruptsOnly(result.closed.cause))
					assert.deepStrictEqual(
						Array.fromIterable(Cause.interruptors(result.closed.cause)),
						[finalizer === "self" ? result.closer : result.canceller],
					)
				}
			}),
	)
}

it.effect("cannot attribute two interruptions by their shared initiator", () =>
	Effect.gen(function* () {
		const owner = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
		const child = yield* Effect.forkScoped(Effect.never)
		yield* Fiber.interrupt(child)
		const childExit = yield* Fiber.await(child)
		assert(Exit.isFailure(childExit))
		const entered = yield* Deferred.make<void>()
		const resume = yield* Deferred.make<void>()
		const report = yield* Deferred.make<{
			readonly closed: Exit.Exit<void>
			readonly pending: Exit.Exit<void>
		}>()
		const scope = yield* Scope.make()
		yield* Scope.addFinalizer(
			scope,
			Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Deferred.await(resume)),
			),
		)
		yield* Scope.addFinalizer(scope, Fiber.join(child))
		const closer = yield* Effect.gen(function* () {
			const closed = yield* Effect.exit(Scope.close(scope, Exit.void))
			const pending = yield* Effect.exit(Effect.interruptible(Effect.void))
			yield* Deferred.succeed(report, { closed, pending })
			return yield* closed
		}).pipe(Effect.uninterruptible, Effect.forkScoped)
		yield* Deferred.await(entered)
		const cancelling = yield* Fiber.interruptAs(closer, owner).pipe(
			Effect.forkScoped({ startImmediately: true }),
		)
		yield* Deferred.succeed(resume, undefined)
		const { closed, pending } = yield* Deferred.await(report)
		yield* Fiber.join(cancelling)
		const outer = yield* Fiber.await(closer)
		assert(Exit.isFailure(outer))
		assert(Exit.isFailure(closed))
		assert(Exit.isFailure(pending))
		for (const cause of [childExit.cause, closed.cause, pending.cause]) {
			assert.isTrue(Cause.hasInterruptsOnly(cause))
			assert.deepStrictEqual([...Cause.interruptors(cause)], [owner])
		}
	}).pipe(Effect.scoped),
)

it.effect(
	"combines equal interrupt reasons without preserving their occurrences",
	() =>
		Effect.gen(function* () {
			const id = yield* Effect.withFiber((self) => Effect.succeed(self.id))
			const combined = Cause.combine(Cause.interrupt(id), Cause.interrupt(id))
			assert.strictEqual(combined.reasons.length, 1)
		}),
)

it.effect(
	"does not turn a finalizer's self-interruption into pending cancellation",
	() =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			yield* Scope.addFinalizer(scope, Effect.interrupt)
			const closed = yield* Effect.exit(Scope.close(scope, Exit.void))
			const pending = yield* Effect.exit(Effect.interruptible(Effect.void))
			assert(Exit.isFailure(closed))
			assert.isTrue(Cause.hasInterruptsOnly(closed.cause))
			assert.deepStrictEqual(pending, Exit.void)
		}).pipe(Effect.uninterruptible),
)
