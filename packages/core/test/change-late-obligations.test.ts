import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Option,
	Stream,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate } from "./change-driver.ts"
import { run } from "./utils.ts"

for (const mode of ["transfer", "command"] as const)
	it.effect(
		mode === "transfer"
			? "keeps transferred serving ownership separate when late metadata cleanup settles after execution exit"
			: "waits for a late termination command executor before releasing its host resources",
		() =>
			run(
				Effect.gen(function* () {
					const prepEntered = yield* Deferred.make<void>()
					const prepRelease = yield* Deferred.make<void>()
					const hostEntered = yield* Deferred.make<void>()
					const hostRelease = yield* Deferred.make<void>()
					const commandEntered = yield* Deferred.make<void>()
					const commandRelease = yield* Deferred.make<void>()
					const servingExit = yield* Deferred.make<Change.Termination>()
					const cleaned = yield* TxRef.make(false)
					const commands = yield* TxRef.make(0)
					const driver: Transition.Driver = {
						name: "controlled",
						prepare: () =>
							(mode === "transfer"
								? Effect.addFinalizer(() =>
										Deferred.succeed(prepEntered, undefined).pipe(
											Effect.andThen(Deferred.await(prepRelease)),
										),
									)
								: Effect.void
							).pipe(Effect.as({ overlap: true })),
						allocate: (_desired, term, acknowledgement) =>
							Effect.gen(function* () {
								if (term === (mode === "transfer" ? 2 : 1))
									yield* Effect.addFinalizer(() =>
										(mode === "transfer"
											? Deferred.succeed(hostEntered, undefined).pipe(
													Effect.andThen(Deferred.await(hostRelease)),
												)
											: Effect.void
										).pipe(Effect.andThen(TxRef.set(cleaned, true))),
									)
								const exited =
									mode === "transfer" && term === 2
										? servingExit
										: yield* Deferred.make<Change.Termination>()
								const terminate = Effect.gen(function* () {
									if (mode === "command" && term === 1) {
										const count = yield* TxRef.modify(commands, (n) => [
											n + 1,
											n + 1,
										])
										if (count === 1) return
										yield* Effect.uninterruptible(
											Deferred.succeed(exited, {
												unit: `late-${term}`,
												state: "Exited",
											}).pipe(
												Effect.andThen(
													Deferred.succeed(commandEntered, undefined),
												),
												Effect.andThen(Deferred.await(commandRelease)),
											),
										)
									} else
										yield* Deferred.succeed(exited, {
											unit: `late-${term}`,
											state: "Exited",
										})
								})
								return {
									acknowledgement,
									start: Effect.void,
									describe: Effect.succeed({ overlap: true, provides: [] }),
									serve: Effect.void,
									ready: Effect.succeed(Context.empty()),
									probe: () => Effect.void,
									stop: Effect.void,
									terminate,
									exited: Deferred.await(exited),
									failure: Effect.never,
								}
							}),
					}
					const fork = yield* Graft.plugin(
						Plugin.make({
							name: "late obligations",
							apply: () =>
								Transition.registerDriver(driver, {
									instance: "late",
									initial: candidate("old"),
									budget,
									required: [],
									facades: [],
								}),
						}),
					)
					yield* fork.await
					const trial = yield* Change.changes.pipe(
						Stream.filter(
							(status) =>
								status.instance === "late" && status.phase === "Trial",
						),
						Stream.runHead,
						Effect.forkScoped({ startImmediately: true }),
					)
					const terminating = yield* Change.changes.pipe(
						Stream.filter(
							(status) =>
								status.instance === "late" &&
								status.phase === "Terminating" &&
								Array.some(
									status.evidence,
									(item) => item.attempt === 1 && item.phase === "Stopping",
								),
						),
						Stream.runHead,
						Effect.forkScoped({ startImmediately: true }),
					)
					const handle = yield* Change.submit({
						instance: "late",
						candidate: candidate("next"),
						budget,
						requirements: { trial: mode === "command" ? 10 : 0 },
					})
					if (mode === "command") {
						yield* Fiber.join(trial)
						yield* handle.cancel
						yield* Fiber.join(terminating)
					} else yield* Deferred.await(prepEntered)
					yield* TestClock.adjust(1000)
					const outcome = yield* handle.await
					const { runtime } = yield* RuntimeContext
					const indexed = yield* TxRef.get(runtime.instances)
					const managed = HashMap.getUnsafe(indexed, "late")
					const settled = Effect.tx(
						TxRef.get(managed.pending).pipe(
							Effect.flatMap((pending) =>
								HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
							),
						),
					)
					if (mode === "transfer") {
						yield* Deferred.succeed(servingExit, {
							unit: "late-2",
							state: "Exited",
						})
						yield* Deferred.await(hostEntered)
						yield* Deferred.succeed(prepRelease, undefined)
						const waiting = yield* settled.pipe(
							Effect.timeoutOption(1),
							Effect.forkScoped,
						)
						yield* TestClock.adjust(1)
						const released = yield* Fiber.join(waiting)
						yield* Deferred.succeed(hostRelease, undefined)
						assert.isTrue(Option.isSome(released))
					} else {
						yield* Deferred.await(commandEntered)
						yield* Effect.yieldNow
						const premature = yield* TxRef.get(cleaned)
						yield* Deferred.succeed(commandRelease, undefined)
						yield* settled
						assert.isFalse(premature)
					}
					const repeated = yield* handle.await
					assert.equal(outcome._tag, "Stuck")
					assert.strictEqual(repeated, outcome)
				}),
			),
	)
