import { Array, Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { assert, it } from "@effect/vitest"

import * as Release from "../src/Release.ts"
import { observeClose } from "./replay-scope-close-fixture.ts"

// The raw probes below load only Effect; no Graft runtime or adapter is used.
// They pin the Effect 4.1.2 attribution facts that Release.close builds on:
// a self-interruption is attributed to the closer, an external cancellation to
// the canceller, and a shared initiator cannot be told apart from cancellation.

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
		// An Interrupt reason carries only the initiator's fiberId, and cause
		// combination collapses equal reasons, so the child, closed and pending
		// causes cannot be told apart here.
		for (const cause of [childExit.cause, closed.cause, pending.cause]) {
			assert.isTrue(Cause.hasInterruptsOnly(cause))
			assert.deepStrictEqual([...Cause.interruptors(cause)], [owner])
		}
	}).pipe(Effect.scoped),
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
			// Re-entering interruptibility is the probe Release.close uses to read
			// pending cancellation; a self-interruption must not show up there.
			assert.deepStrictEqual(pending, Exit.void)
		}).pipe(Effect.uninterruptible),
)

// Known limitation: when the same initiator both interrupts the joined child
// earlier and cancels the closer, the two interruptions share a fiberId, so
// Release.close cannot classify the joined failure as a ReleaseInterrupted.
// This test pins the limitation; it does not describe the desired contract.
for (const timing of ["before failure", "after failure"] as const) {
	it.effect(
		`currently misclassifies a joined interruption when cancellation arrives ${timing}`,
		() =>
			Effect.gen(function* () {
				const result = yield* observeClose(Release.close, "joined", timing)
				assert(Exit.isFailure(result.closed))
				assert.isTrue(Cause.hasInterruptsOnly(result.closed.cause))
				assert.deepStrictEqual(
					[...Cause.interruptors(result.closed.cause)],
					[result.canceller],
				)
				assert(Exit.isFailure(result.outer))
				assert.isTrue(Cause.hasInterruptsOnly(result.outer.cause))
			}),
	)
}
