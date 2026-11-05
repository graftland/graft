import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Logger,
	Queue,
	Scope,
} from "effect"
import { assert, it } from "@effect/vitest"

import { ownedScope } from "../src/internal/scope.ts"

const logging = Effect.gen(function* () {
	const logged = yield* Queue.unbounded<Logger.Options<unknown>>()
	const layer = Logger.layer([
		Logger.make((options) => {
			Queue.offerUnsafe(logged, options)
		}),
	])
	return { logged, layer }
})

it.effect(
	"hands an explicit close's cleanup failure to the caller without logging it again",
	() =>
		Effect.gen(function* () {
			const { logged, layer } = yield* logging
			const parent = yield* Scope.make()
			const result = yield* Effect.gen(function* () {
				const owned = yield* ownedScope(parent, Effect.fail("cleanup failed"))
				return yield* Effect.exit(owned.close(Exit.void))
			}).pipe(Effect.provide(layer))
			assert.deepStrictEqual(result, Exit.fail("cleanup failed"))
			const logs = yield* Queue.clear(logged)
			assert.deepStrictEqual(logs, [])
			yield* Scope.close(parent, Exit.void)
		}),
)

it.effect(
	"raises a cleanup failure the parent scope started as a defect of the parent close",
	() =>
		Effect.gen(function* () {
			const parent = yield* Scope.make()
			yield* ownedScope(parent, Effect.fail("cleanup failed"))
			const closed = yield* Effect.exit(Scope.close(parent, Exit.void))
			assert.isTrue(Exit.isFailure(closed) && Cause.hasDies(closed.cause))
			if (Exit.isFailure(closed))
				assert.strictEqual(Cause.squash(closed.cause), "cleanup failed")
		}),
)

it.effect(
	"logs a cleanup failure exactly once when the explicit close caller is interrupted",
	() =>
		Effect.gen(function* () {
			const { logged, layer } = yield* logging
			const parent = yield* Scope.make()
			yield* Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const gate = yield* Deferred.make<void>()
				const owned = yield* ownedScope(
					parent,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(gate)),
						Effect.andThen(Effect.fail("cleanup failed")),
					),
				)
				const caller = yield* Effect.forkChild(owned.close(Exit.void))
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(caller)
				yield* Deferred.succeed(gate, undefined)
				// Closing the parent waits for the cleanup worker to finish.
				yield* Scope.close(parent, Exit.void)
			}).pipe(Effect.provide(layer))
			const logs = yield* Queue.clear(logged)
			assert.strictEqual(logs.length, 1)
			const [log] = logs
			assert.deepStrictEqual(log?.message, [
				"Fork cleanup failed after its dispose caller was interrupted",
			])
			assert.strictEqual(
				Cause.squash(log?.cause ?? Cause.empty),
				"cleanup failed",
			)
		}),
)
