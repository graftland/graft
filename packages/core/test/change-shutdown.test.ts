import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Scope,
	Stream,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change } from "../src/index.ts"
import * as AsyncClose from "../src/internal/asyncClose.ts"
import { budget, candidate, register } from "./change-driver.ts"
import { run } from "./utils.ts"

it.effect(
	"starts pending cleanup when invoked from its closing owner finalizer",
	() =>
		Effect.gen(function* () {
			const owner = yield* Scope.make()
			const count = yield* TxRef.make(0)
			const close = yield* AsyncClose.make(
				owner,
				TxRef.update(count, (n) => n + 1),
			)
			yield* Scope.addFinalizer(owner, close.start)
			yield* Scope.close(owner, Exit.void)
			const state = yield* Ref.get(close.state)
			const calls = yield* TxRef.get(count)
			assert.strictEqual(state._tag, "Completed")
			assert.strictEqual(calls, 1)
		}),
)

for (const fails of [false, true])
	it.effect(
		fails
			? "closes a Stuck runtime without exit evidence and retains the original host cleanup failure"
			: "closes a Stuck runtime without exit evidence and completes pending host cleanup",
		() =>
			Effect.gen(function* () {
				const terminating = yield* Deferred.make<void>()
				const recorded = yield* Deferred.make<Change.Outcome>()
				const cleaned = yield* TxRef.make(0)
				const failure = Cause.die("Shutdown host cleanup failed")
				const shutdown = yield* run(
					Effect.gen(function* () {
						yield* register("a", {
							holdOldExit: true,
							cleanup: TxRef.update(cleaned, (n) => n + 1).pipe(
								Effect.andThen(fails ? Effect.failCause(failure) : Effect.void),
							),
						})
						const observed = yield* Change.changes.pipe(
							Stream.filter(
								(status) =>
									status.instance === "a" && status.phase === "Terminating",
							),
							Stream.runHead,
							Effect.forkScoped({ startImmediately: true }),
						)
						const handle = yield* Change.submit({
							instance: "a",
							candidate: candidate("next"),
							budget,
						})
						yield* Fiber.join(observed)
						yield* Deferred.succeed(terminating, undefined)
						const outcome = yield* handle.await
						assert.strictEqual(outcome._tag, "Stuck")
						yield* Deferred.succeed(recorded, outcome)
					}),
				).pipe(Effect.exit, Effect.forkScoped)
				yield* Deferred.await(terminating)
				yield* TestClock.adjust(budget.total)
				const result = yield* Fiber.join(shutdown)
				const outcome = yield* Deferred.await(recorded)
				const calls = yield* TxRef.get(cleaned)
				assert.strictEqual(outcome._tag, "Stuck")
				assert.strictEqual(calls, 1)
				assert.isTrue(Exit.isFailure(result))
				if (fails && Exit.isFailure(result))
					assert.include(
						Cause.pretty(result.cause),
						"Shutdown host cleanup failed",
					)
			}),
		3000,
	)
