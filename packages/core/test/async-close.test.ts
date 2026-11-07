import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Scope,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import * as AsyncClose from "../src/internal/asyncClose.ts"

it.effect(
	"retains one original close result across concurrent starts and interrupted waits",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const owner = yield* Effect.scope
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const count = yield* TxRef.make(0)
				const failure = Cause.die("Original close failure")
				const close = yield* AsyncClose.make(
					owner,
					TxRef.update(count, (n) => n + 1).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(Effect.failCause(failure)),
					),
				)
				yield* Effect.forEach(Array.range(1, 5), () => close.start, {
					concurrency: 5,
				})
				yield* Deferred.await(entered)
				const waiter = yield* close.await.pipe(Effect.forkScoped)
				yield* Fiber.interrupt(waiter)
				yield* Deferred.succeed(release, undefined)
				const original = yield* close.await
				yield* close.start
				const repeated = yield* close.await
				const calls = yield* TxRef.get(count)
				assert.strictEqual(calls, 1)
				assert.strictEqual(repeated, original)
				assert.deepStrictEqual(original, Exit.failCause(failure))
			}),
		),
)

it.effect(
	"retains an interrupt-only original exit without retrying close",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const owner = yield* Effect.scope
				const close = yield* AsyncClose.make(owner, Effect.interrupt)
				yield* close.start
				const original = yield* close.await
				yield* close.start
				const repeated = yield* close.await
				assert.isTrue(
					Exit.isFailure(original) && Cause.hasInterruptsOnly(original.cause),
				)
				assert.strictEqual(repeated, original)
				const state = yield* Ref.get(close.state)
				assert.strictEqual(state._tag, "Completed")
			}),
		),
)

it.effect(
	"can finish unstarted cleanup synchronously during owner shutdown",
	() =>
		Effect.gen(function* () {
			const owner = yield* Scope.make()
			const count = yield* TxRef.make(0)
			const close = yield* AsyncClose.make(
				owner,
				TxRef.update(count, (n) => n + 1),
			)
			yield* Scope.addFinalizer(owner, close.dispose)
			yield* Scope.close(owner, Exit.void)
			const original = yield* close.await
			const calls = yield* TxRef.get(count)
			assert.strictEqual(calls, 1)
			assert.deepStrictEqual(original, Exit.void)
		}),
)
