import {
	Array,
	Cause,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Logger,
	Queue,
	References,
	String,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate, register } from "./change-driver.ts"
import { run } from "./utils.ts"

for (const fails of [false, true])
	it.effect(
		fails
			? "logs the full late failure of redundant preparation cleanup after returning the duplicate handle"
			: "a concurrent duplicate returns the original handle while redundant preparation cleanup is blocked",
		() =>
			Effect.gen(function* () {
				const logs = yield* Queue.unbounded<Logger.Options<unknown>>()
				const logging = Logger.layer([
					Logger.make((entry) => {
						Queue.offerUnsafe(logs, entry)
					}),
				])
				yield* run(
					Effect.gen(function* () {
						const count = yield* TxRef.make(0)
						const firstEntered = yield* Deferred.make<void>()
						const secondEntered = yield* Deferred.make<void>()
						const firstRelease = yield* Deferred.make<void>()
						const secondRelease = yield* Deferred.make<void>()
						const cleanupEntered = yield* Deferred.make<void>()
						const cleanupRelease = yield* Deferred.make<void>()
						yield* register("a", {
							prepare: () =>
								Effect.gen(function* () {
									const n = yield* TxRef.modify(count, (n) => [n + 1, n + 1])
									if (n === 2)
										yield* Effect.addFinalizer(() =>
											Deferred.succeed(cleanupEntered, undefined).pipe(
												Effect.andThen(Deferred.await(cleanupRelease)),
												Effect.andThen(
													fails
														? Effect.die("Redundant metadata cleanup failed")
														: Effect.void,
												),
											),
										)
									yield* Deferred.succeed(
										n === 1 ? firstEntered : secondEntered,
										undefined,
									)
									yield* Deferred.await(n === 1 ? firstRelease : secondRelease)
									return { overlap: true }
								}),
						})
						const request: Change.Request = {
							key: "duplicate",
							instance: "a",
							candidate: candidate("next"),
							budget,
						}
						const first = yield* Change.submit(request).pipe(Effect.forkScoped)
						yield* Deferred.await(firstEntered)
						const second = yield* Change.submit(request).pipe(Effect.forkScoped)
						yield* Deferred.await(secondEntered)
						yield* Deferred.succeed(firstRelease, undefined)
						const original = yield* Fiber.join(first)
						yield* original.await
						yield* Deferred.succeed(secondRelease, undefined)
						yield* Deferred.await(cleanupEntered)
						yield* TestClock.adjust(10000)
						const pending = second.pollUnsafe()
						yield* Deferred.succeed(cleanupRelease, undefined)
						const duplicate = yield* Fiber.join(second)
						assert.strictEqual(duplicate.id, original.id)
						assert.isTrue(pending !== undefined)
						if (fails) {
							const logged = yield* Queue.take(logs)
							assert.strictEqual(
								Cause.squash(logged.cause),
								"Redundant metadata cleanup failed",
							)
						}
					}),
				).pipe(Effect.provide(logging))
			}),
	)

it.effect("cancelling submission releases its metadata preparation", () =>
	run(
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const cleaned = yield* Deferred.make<void>()
			yield* register("a", {
				prepare: () =>
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(cleaned, undefined),
						)
						yield* Deferred.succeed(entered, undefined)
						return yield* Effect.never
					}),
			})
			const submission = yield* Change.submit({
				instance: "a",
				candidate: candidate("next"),
				budget,
			}).pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* Fiber.interrupt(submission)
			const { runtime } = yield* RuntimeContext
			const retained = yield* TxRef.get(runtime.changes.preparations)
			const completed = yield* Deferred.isDone(cleaned)
			assert.isTrue(
				completed,
				`Cancelled preparation remains retained: ${HashSet.size(retained)}`,
			)
		}),
	),
)

it.effect(
	"returns cancelled submission while the runtime still owns slow metadata cleanup",
	() =>
		run(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const cleanupEntered = yield* Deferred.make<void>()
				const cleanupRelease = yield* Deferred.make<void>()
				yield* register("a", {
					prepare: () =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Deferred.succeed(cleanupEntered, undefined).pipe(
									Effect.andThen(Deferred.await(cleanupRelease)),
								),
							)
							yield* Deferred.succeed(entered, undefined)
							return yield* Effect.never
						}),
				})
				const submission = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				}).pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const interrupted = yield* Fiber.interrupt(submission).pipe(
					Effect.forkScoped,
				)
				yield* Deferred.await(cleanupEntered)
				yield* TestClock.adjust(100)
				yield* Fiber.join(interrupted)
				const { runtime } = yield* RuntimeContext
				const retained = yield* TxRef.get(runtime.changes.preparations)
				assert.strictEqual(HashSet.size(retained), 1)
				yield* Deferred.succeed(cleanupRelease, undefined)
				yield* Effect.tx(
					TxRef.get(runtime.changes.preparations).pipe(
						Effect.flatMap((pending) =>
							HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
						),
					),
				)
			}),
		),
)

it.effect("metadata preparation respects its startup deadline", () =>
	run(
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			yield* register("a", {
				prepare: () =>
					Effect.uninterruptible(
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as({ overlap: true }),
						),
					),
			})
			const submission = yield* Change.submit({
				instance: "a",
				candidate: candidate("next"),
				budget,
			}).pipe(Effect.exit, Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* TestClock.adjust(10000)
			const observed = submission.pollUnsafe()
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(submission)
			assert.isDefined(
				observed,
				"Metadata preparation is still waiting after 100 startup budgets",
			)
		}),
	),
)

for (const fails of [false, true])
	it.effect(
		fails
			? "retains a late uninterruptible preparation failure and cleans its resources after execution ends"
			: "cleans both early and late resources only after timed-out preparation execution ends",
		() =>
			Effect.gen(function* () {
				const logs = yield* Queue.unbounded<Logger.Options<unknown>>()
				const logging = Logger.layer([
					Logger.make((entry) => {
						Queue.offerUnsafe(logs, entry)
					}),
				])
				yield* run(
					Effect.gen(function* () {
						const events = yield* TxRef.make<ReadonlyArray<string>>([])
						const entered = yield* Deferred.make<void>()
						const release = yield* Deferred.make<void>()
						yield* register("a", {
							prepare: () =>
								Effect.uninterruptible(
									Effect.gen(function* () {
										yield* Effect.addFinalizer(() =>
											TxRef.update(events, Array.append("early cleanup")),
										)
										yield* Deferred.succeed(entered, undefined)
										yield* Deferred.await(release)
										yield* Effect.addFinalizer(() =>
											TxRef.update(events, Array.append("late cleanup")),
										)
										yield* TxRef.update(events, Array.append("execution ended"))
										return yield* fails
											? Effect.die("Late metadata execution failed")
											: Effect.succeed({ overlap: true })
									}),
								),
						})
						const submission = yield* Change.submit({
							instance: "a",
							key: "timed-out-metadata",
							candidate: candidate("next"),
							budget,
						}).pipe(Effect.exit, Effect.forkScoped)
						yield* Deferred.await(entered)
						yield* TestClock.adjust(200)
						assert.isDefined(submission.pollUnsafe())
						const result = yield* Fiber.join(submission)
						assert.isTrue(result._tag === "Failure")
						const before = yield* TxRef.get(events)
						assert.deepStrictEqual(before, [])
						const { runtime } = yield* RuntimeContext
						const retained = yield* TxRef.get(runtime.changes.preparations)
						assert.strictEqual(HashSet.size(retained), 1)
						yield* Deferred.succeed(release, undefined)
						yield* Effect.tx(
							TxRef.get(runtime.changes.preparations).pipe(
								Effect.flatMap((pending) =>
									HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
								),
							),
						)
						const after = yield* TxRef.get(events)
						assert.deepStrictEqual(after, [
							"execution ended",
							"late cleanup",
							"early cleanup",
						])
						const changes = yield* TxRef.get(runtime.changes.records)
						assert.strictEqual(HashMap.size(changes), 0)
					}),
				).pipe(Effect.provide(logging))
				if (fails) {
					const observed = yield* Queue.clear(logs)
					assert.isTrue(
						Array.some(observed, (entry) =>
							String.includes("Late metadata execution failed")(
								Cause.pretty(entry.cause),
							),
						),
					)
				}
			}),
	)

for (const mode of ["rejection", "failure", "cancellation"] as const)
	it.effect(
		mode === "rejection"
			? "late metadata cleanup failures after rejection remain observable"
			: mode === "failure"
				? "logs the complete late cleanup cause after preparation failure with request correlation"
				: "logs the complete late cleanup cause after submission cancellation with request correlation",
		() =>
			Effect.gen(function* () {
				const logs = yield* Queue.unbounded<{
					readonly cause: Cause.Cause<unknown>
					readonly annotations: Readonly<Record<string, unknown>>
				}>()
				const logging = Logger.layer([
					Logger.make((entry) => {
						Queue.offerUnsafe(logs, {
							cause: entry.cause,
							annotations: {
								...entry.fiber.getRef(References.CurrentLogAnnotations),
							},
						})
					}),
				])
				const failure = Cause.combine(
					Cause.die("Late metadata cleanup failure"),
					Cause.die("Cleanup detail"),
				)
				yield* run(
					Effect.gen(function* () {
						const preparing = yield* Deferred.make<void>()
						const entered = yield* Deferred.make<void>()
						const release = yield* Deferred.make<void>()
						yield* register("a", {
							prepare: () =>
								Effect.gen(function* () {
									yield* Effect.addFinalizer(() =>
										Deferred.succeed(entered, undefined).pipe(
											Effect.andThen(Deferred.await(release)),
											Effect.andThen(Effect.failCause(failure)),
										),
									)
									yield* Deferred.succeed(preparing, undefined)
									if (mode === "cancellation") return yield* Effect.never
									if (mode === "failure")
										return yield* Effect.die("Metadata preparation failed")
									return { overlap: false }
								}),
						})
						const submit = yield* Change.submit({
							instance: "a",
							key: `${mode}-metadata`,
							candidate: candidate("next"),
							strategy: "Overlap",
							budget,
						}).pipe(Effect.exit, Effect.forkScoped)
						if (mode === "cancellation") {
							yield* Deferred.await(preparing)
							const cancelled = yield* Fiber.interrupt(submit).pipe(
								Effect.forkScoped,
							)
							yield* Deferred.await(entered)
							yield* TestClock.adjust(100)
							yield* Fiber.join(cancelled)
						} else {
							yield* Deferred.await(entered)
							yield* TestClock.adjust(100)
							yield* Fiber.join(submit)
						}
						yield* Deferred.succeed(release, undefined)
						const { runtime } = yield* RuntimeContext
						yield* Effect.tx(
							TxRef.get(runtime.changes.preparations).pipe(
								Effect.flatMap((pending) =>
									HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
								),
							),
						)
					}),
				).pipe(Effect.provide(logging))
				const observed = yield* Queue.clear(logs)
				const cleanup = Array.filter(observed, (entry) =>
					String.includes("Late metadata cleanup failure")(
						Cause.pretty(entry.cause),
					),
				)
				assert.strictEqual(cleanup.length, 1)
				const entry = cleanup[0]
				assert.isDefined(entry)
				if (entry !== undefined) {
					assert.strictEqual(entry.annotations["instance"], "a")
					assert.strictEqual(entry.annotations["key"], `${mode}-metadata`)
					assert.deepStrictEqual(
						Array.map(
							Array.filter(entry.cause.reasons, Cause.isDieReason),
							(reason) => reason.defect,
						),
						["Late metadata cleanup failure", "Cleanup detail"],
					)
				}
			}),
	)
