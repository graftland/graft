import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Option,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate } from "./change-driver.ts"
import { run } from "./utils.ts"

for (const operation of ["startup", "termination"] as const)
	it.effect(
		operation === "startup"
			? "retains host resources until an uninterruptible startup operation exits after unit termination"
			: "retains host resources until an uninterruptible termination command exits after unit termination",
		() =>
			run(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const events = yield* TxRef.make<ReadonlyArray<string>>([])
					const driver: Transition.Driver = {
						name: "controlled",
						overlap: () => true,
						allocate: (_desired, term, acknowledgement) =>
							Effect.gen(function* () {
								if (term === 2)
									yield* Effect.addFinalizer(() =>
										TxRef.update(events, Array.append("cleanup")),
									)
								const exited = yield* Deferred.make<Change.Termination>()
								return {
									acknowledgement,
									start:
										term === 2 && operation === "startup"
											? Effect.uninterruptible(
													Deferred.succeed(entered, undefined).pipe(
														Effect.andThen(Deferred.await(release)),
														Effect.andThen(
															TxRef.update(
																events,
																Array.append("startup ended"),
															),
														),
													),
												)
											: Effect.void,
									describe: Effect.succeed({ overlap: true, provides: [] }),
									serve: Effect.void,
									ready:
										term === 2 && operation === "termination"
											? Transition.DriverError.make({
													cause: Cause.fail("Candidate readiness failed"),
												})
											: Effect.succeed(Context.empty()),
									probe: () => Effect.void,
									stop: Effect.void,
									terminate: Deferred.succeed(exited, {
										unit: `lifetime-${term}`,
										state: "Exited",
									}).pipe(
										Effect.andThen(
											term === 2 && operation === "termination"
												? Effect.uninterruptible(
														Deferred.succeed(entered, undefined).pipe(
															Effect.andThen(Deferred.await(release)),
															Effect.andThen(
																TxRef.update(
																	events,
																	Array.append("termination ended"),
																),
															),
														),
													)
												: Effect.void,
										),
									),
									exited: Deferred.await(exited),
									failure: Effect.never,
								}
							}),
					}
					const fork = yield* Graft.plugin(
						Plugin.make({
							name: "lifetime",
							apply: () =>
								Transition.registerDriver(driver, {
									instance: "lifetime",
									initial: candidate("old"),
									budget,
									required: [],
									facades: [],
								}),
						}),
					)
					yield* fork.await
					const handle = yield* Change.submit({
						instance: "lifetime",
						candidate: candidate("next"),
						budget,
					})
					yield* Deferred.await(entered)
					const waiting = yield* handle.await.pipe(Effect.forkScoped)
					yield* TestClock.adjust(1000)
					const bounded = waiting.pollUnsafe()
					if (bounded === undefined) yield* Deferred.succeed(release, undefined)
					const outcome = yield* Fiber.join(waiting)
					const before = yield* TxRef.get(events)
					yield* Deferred.succeed(release, undefined)
					const { runtime } = yield* RuntimeContext
					const indexed = yield* TxRef.get(runtime.instances)
					const managed = Option.getOrThrow(HashMap.get(indexed, "lifetime"))
					yield* Effect.tx(
						TxRef.get(managed.pending).pipe(
							Effect.flatMap((pending) =>
								HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
							),
						),
					)
					const after = yield* TxRef.get(events)
					const repeated = yield* handle.await
					assert.isDefined(bounded)
					assert.deepStrictEqual(before, [])
					assert.deepStrictEqual(after, [`${operation} ended`, "cleanup"])
					assert.equal(outcome._tag, "Stuck")
					assert.strictEqual(repeated, outcome)
				}),
			),
	)
