import { Cause, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { assert, it } from "@effect/vitest"

import * as Finalization from "../src/Finalization.ts"
import { observeClose } from "./scope-close-attribution-fixture.ts"

it.effect(
	"marks a self-interrupted finalizer while retaining pending cancellation",
	() =>
		Effect.gen(function* () {
			const result = yield* observeClose(Finalization.close, "self")
			assert(Exit.isFailure(result.closed))
			const defect = Cause.squash(result.closed.cause)
			assert(Schema.is(Finalization.FinalizationInterrupted)(defect))
			assert.deepStrictEqual(
				[...Cause.interruptors(defect.cause)],
				[result.closer],
			)
			assert(Exit.isFailure(result.outer))
			assert.isTrue(Cause.hasDies(result.outer.cause))
			assert.isTrue(
				Cause.interruptors(result.outer.cause).has(result.canceller),
			)
		}),
)

for (const finalizer of ["masked", "interruptible"] as const) {
	it.effect(
		`does not mark ${finalizer} finalization as an independent interruption`,
		() =>
			Effect.gen(function* () {
				const result = yield* observeClose(Finalization.close, finalizer)
				assert.deepStrictEqual(result.before, Exit.void)
				assert(Exit.isFailure(result.outer))
				assert.isTrue(Cause.hasInterruptsOnly(result.outer.cause))
				if (finalizer === "masked")
					assert.deepStrictEqual(result.closed, Exit.void)
				else {
					assert(Exit.isFailure(result.closed))
					assert.isTrue(Cause.hasInterruptsOnly(result.closed.cause))
				}
			}),
	)
}

for (const timing of ["before failure", "after failure"] as const) {
	it.effect(
		`currently misclassifies a joined interruption when cancellation arrives ${timing}`,
		() =>
			Effect.gen(function* () {
				const result = yield* observeClose(Finalization.close, "joined", timing)
				assert(Exit.isFailure(result.closed))
				// Characterize the bug, not the desired contract: both interruptions have
				// the same initiator, but the joined child's failure is independent.
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

it.effect(
	"marks the same joined interruption when the closer has no pending cancellation",
	() =>
		Effect.gen(function* () {
			const child = yield* Effect.forkScoped(Effect.never)
			yield* Fiber.interrupt(child)
			const childExit = yield* Fiber.await(child)
			assert(Exit.isFailure(childExit))
			const scope = yield* Scope.make()
			yield* Scope.addFinalizer(scope, Fiber.join(child))
			const closed = yield* Effect.exit(Finalization.close(scope, Exit.void))
			assert(Exit.isFailure(closed))
			const defect = Cause.squash(closed.cause)
			assert(Schema.is(Finalization.FinalizationInterrupted)(defect))
			assert.deepStrictEqual(
				[...Cause.interruptors(defect.cause)],
				[...Cause.interruptors(childExit.cause)],
			)
		}).pipe(Effect.scoped),
)
