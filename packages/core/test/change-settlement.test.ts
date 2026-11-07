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

it.effect("live trial status reports the committed route and version", () =>
	run(
		Effect.gen(function* () {
			yield* register("a")
			const trial = yield* Change.changes.pipe(
				Stream.filter((s) => s.instance === "a" && s.phase === "Trial"),
				Stream.runHead,
				Effect.forkScoped({ startImmediately: true }),
			)
			const handle = yield* Change.submit({
				instance: "a",
				candidate: candidate("next"),
				budget,
				requirements: { trial: 1000 },
			})
			const trialStatus = yield* Fiber.join(trial)
			const observedStatus = yield* Change.get(handle.id)
			const status = Option.getOrThrow(observedStatus)
			const { runtime } = yield* RuntimeContext
			const instances = yield* TxRef.get(runtime.instances)
			const managed = HashMap.getUnsafe(instances, "a")
			const route = yield* TxRef.get(managed.route)
			const actualRoute = Option.getOrThrow(route)
			yield* TestClock.adjust(1000)
			yield* handle.await
			assert.strictEqual(
				Option.getOrThrow(trialStatus).members[0]?.actual.generation,
				actualRoute.id,
			)
			assert.strictEqual(
				Option.getOrThrow(trialStatus).members[0]?.actual.version,
				2,
			)
			assert.isTrue(
				Option.getOrThrow(trialStatus).members[0]?.actual.matchesTarget,
			)
			assert.strictEqual(status.members[0]?.actual.generation, actualRoute.id)
			assert.strictEqual(status.members[0]?.actual.version, 2)
			assert.isTrue(status.members[0]?.actual.matchesTarget)
		}),
	),
)

it.effect(
	"refreshes availability after an accepted generation exits without rewriting its outcome snapshot",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("a")
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				const accepted = yield* handle.await
				assert.strictEqual(accepted._tag, "Accepted")
				const { runtime } = yield* RuntimeContext
				const instances = yield* TxRef.get(runtime.instances)
				const managed = HashMap.getUnsafe(instances, "a")
				const selected = yield* TxRef.get(managed.route)
				const route = Option.getOrThrow(selected)
				const unavailable = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.id === handle.id &&
							status.members[0]?.actual.health === "Unavailable",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				yield* route.unit.terminate
				const changed = yield* Fiber.join(unavailable)
				const observed = yield* Change.get(handle.id)
				const status = Option.getOrThrow(observed)
				assert.strictEqual(
					Option.getOrThrow(changed).members[0]?.actual.generation,
					undefined,
				)
				assert.strictEqual(status.members[0]?.actual.health, "Unavailable")
				assert.strictEqual(status.members[0]?.actual.matchesTarget, false)
				assert.deepStrictEqual(status.outcome, Option.some(accepted))
				assert.strictEqual(accepted.members[0]?.actual.health, "Serving")
				assert.strictEqual(accepted.members[0]?.actual.generation, 2)
			}),
		),
)

it.effect(
	"reports an unavailable current route while Restart waits for candidate readiness",
	() =>
		run(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>()
				const h = yield* register("a", { ready: Deferred.await(ready) })
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Restart",
					budget,
				})
				yield* Deferred.await(h.entered)
				const current = yield* Change.get(handle.id)
				const status = Option.getOrThrow(current)
				assert.strictEqual(status.members[0]?.actual.health, "Unavailable")
				assert.strictEqual(status.members[0]?.actual.generation, undefined)
				assert.strictEqual(status.members[0]?.actual.version, 1)
				assert.strictEqual(status.members[0]?.actual.matchesTarget, false)
				yield* Deferred.succeed(ready, undefined)
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Accepted")
				assert.strictEqual(outcome.members[0]?.actual.generation, 2)
				assert.strictEqual(outcome.members[0]?.actual.version, 2)
			}),
		),
)
