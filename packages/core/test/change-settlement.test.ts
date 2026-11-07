import { Deferred, Effect, Fiber, HashMap, Option, Stream, TxRef } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate, register } from "./change-driver.ts"
import { run } from "./utils.ts"

for (const blocked of [false, true])
	it.effect(
		blocked
			? "publishes late lease release before blocked host cleanup finishes without rewriting Stuck"
			: "late exit removes the old generation from current lease-holder facts",
		() =>
			run(
				Effect.gen(function* () {
					yield* register("provider", { facade: true })
					const cleanupEntered = yield* Deferred.make<void>()
					const cleanupRelease = yield* Deferred.make<void>()
					const h = yield* register("a", {
						inject: true,
						holdOldExit: true,
						cleanup: blocked
							? Deferred.succeed(cleanupEntered, undefined).pipe(
									Effect.andThen(Deferred.await(cleanupRelease)),
								)
							: Effect.void,
					})
					yield* Effect.addFinalizer(() =>
						Deferred.succeed(cleanupRelease, undefined),
					)
					const terminating = yield* Change.changes.pipe(
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
					yield* Fiber.join(terminating)
					yield* TestClock.adjust(100)
					const outcome = yield* handle.await
					assert.strictEqual(outcome._tag, "Stuck")
					yield* Deferred.succeed(h.oldExit, { unit: "a-1", state: "Exited" })
					if (blocked) {
						yield* Deferred.await(cleanupEntered)
						const pending = yield* Change.get(handle.id)
						const status = Option.getOrThrow(pending)
						assert.deepStrictEqual(status.leaseHolders, [])
						assert.deepStrictEqual(status.outcome, Option.some(outcome))
						yield* Deferred.succeed(cleanupRelease, undefined)
					}
					const { runtime } = yield* RuntimeContext
					yield* Effect.tx(
						Effect.gen(function* () {
							const objects = yield* TxRef.get(runtime.changes.objects)
							const cell = HashMap.getUnsafe(objects, {
								_tag: "Instance",
								instance: "a",
							})
							if (Option.isSome((yield* TxRef.get(cell)).writer))
								return yield* Effect.txRetry
						}),
					)
					const observed = yield* Change.get(handle.id)
					const status = Option.getOrThrow(observed)
					const instances = yield* TxRef.get(runtime.instances)
					const managed = HashMap.getUnsafe(instances, "a")
					const attempts = yield* TxRef.get(managed.attempts)
					assert.deepStrictEqual(attempts, [])
					assert.deepStrictEqual(status.leaseHolders, [])
					assert.deepStrictEqual(status.outcome, Option.some(outcome))
				}),
			),
	)
