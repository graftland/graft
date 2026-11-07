import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Option,
	String,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate } from "./change-driver.ts"
import { run } from "./utils.ts"

for (const mode of [
	"deadline",
	"cancellation",
	"late failure",
	"recovery",
] as const)
	it.effect(
		mode === "deadline"
			? "timed-out allocation retains resources and reservations until its original executor exits"
			: mode === "cancellation"
				? "cancelled allocation keeps capacity and resources until its original executor exits"
				: mode === "late failure"
					? "retains the full late allocation failure without rewriting its Stuck outcome"
					: "keeps an unconfirmed recovery allocation Stuck until its actual executor exits",
		() =>
			run(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const cleaned = yield* TxRef.make(false)
					const events = yield* TxRef.make<ReadonlyArray<string>>([])
					const driver: Transition.Driver = {
						name: "controlled",
						overlap: () => true,
						allocate: (_desired, term, acknowledgement) =>
							Effect.uninterruptible(
								Effect.gen(function* () {
									if (term === (mode === "recovery" ? 3 : 2)) {
										yield* Effect.addFinalizer(() => TxRef.set(cleaned, true))
										yield* Deferred.succeed(entered, undefined)
										yield* Deferred.await(release)
										yield* Effect.addFinalizer(() =>
											TxRef.update(events, Array.append("late cleanup")),
										)
										yield* TxRef.update(events, Array.append("executor ended"))
										if (mode === "late failure")
											return yield* Effect.die("Late allocation failure")
									}
									const exited = yield* Deferred.make<Change.Termination>()
									return {
										acknowledgement,
										start:
											mode === "recovery" && term === 2
												? Transition.DriverError.make({
														cause: Cause.fail("Candidate startup failed"),
													})
												: Effect.void,
										describe: Effect.succeed({ overlap: true, provides: [] }),
										serve: Effect.void,
										ready: Effect.succeed(Context.empty()),
										probe: () => Effect.void,
										stop: Effect.void,
										terminate: Deferred.succeed(exited, {
											unit: `allocation-${term}`,
											state: "Exited",
										}).pipe(Effect.asVoid),
										exited: Deferred.await(exited),
										failure: Effect.never,
									}
								}),
							),
					}
					const fork = yield* Graft.plugin(
						Plugin.make({
							name: "allocation",
							apply: () =>
								Transition.registerDriver(driver, {
									instance: "allocation",
									initial: candidate("old"),
									budget,
									required: [],
									facades: [],
								}),
						}),
					)
					yield* fork.await
					const handle = yield* Change.submit({
						instance: "allocation",
						candidate: candidate("next"),
						strategy: mode === "recovery" ? "Restart" : "Overlap",
						budget,
					})
					yield* Deferred.await(entered)
					if (mode === "cancellation") yield* handle.cancel
					const waiting = yield* handle.await.pipe(Effect.forkScoped)
					yield* TestClock.adjust(1000)
					const bounded = waiting.pollUnsafe()
					if (bounded === undefined) yield* Deferred.succeed(release, undefined)
					const outcome = yield* Fiber.join(waiting)
					const prematurelyCleaned = yield* TxRef.get(cleaned)
					const { runtime } = yield* RuntimeContext
					const instances = yield* TxRef.get(runtime.instances)
					const managed = Option.getOrThrow(
						HashMap.get(instances, "allocation"),
					)
					const before = yield* TxRef.get(managed.leases)
					const occupied = yield* TxRef.get(runtime.capacity)
					const blocked = yield* Change.submit({
						instance: "allocation",
						candidate: candidate("third"),
						budget,
					}).pipe(Effect.exit)
					yield* Deferred.succeed(release, undefined)
					yield* Effect.tx(
						TxRef.get(managed.pending).pipe(
							Effect.flatMap((pending) =>
								HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
							),
						),
					)
					const after = yield* TxRef.get(managed.leases)
					const observed = yield* Change.get(handle.id)
					const capacity = yield* TxRef.get(runtime.capacity)
					const sequence = yield* TxRef.get(events)
					const repeated = yield* handle.await
					assert.strictEqual(repeated, outcome)
					assert.equal(occupied.used, 1)
					assert.equal(capacity.used, 0)
					assert.deepStrictEqual(sequence, ["executor ended", "late cleanup"])
					if (mode === "late failure")
						assert.isTrue(
							Array.some(
								Option.getOrThrow(observed).evidence,
								(item) =>
									item.cause !== undefined &&
									String.includes("Late allocation failure")(
										Cause.pretty(item.cause),
									),
							),
						)
					assert.isDefined(bounded)
					assert.isTrue(Exit.isFailure(blocked))
					if (Exit.isFailure(blocked))
						assert.include(
							Array.map(
								Array.filter(blocked.cause.reasons, Cause.isFailReason),
								(reason) => reason.error.reason._tag,
							),
							"Busy",
						)
					assert.deepStrictEqual(
						Array.map(before, (lease) => lease.id),
						[mode === "recovery" ? 3 : 2],
					)
					assert.equal(after.length, 0)
					assert.equal(Option.getOrThrow(observed).outcome._tag, "Some")
					assert.equal(outcome._tag, "Stuck")
					assert.isFalse(
						prematurelyCleaned,
						`Allocation is still running, but its resources were closed and outcome is ${outcome._tag}`,
					)
				}),
			),
	)
