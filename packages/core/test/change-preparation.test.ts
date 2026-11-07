import {
	Cause,
	Deferred,
	Effect,
	Fiber,
	HashSet,
	Logger,
	Queue,
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
