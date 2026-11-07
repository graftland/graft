import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Ref,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "../src/index.ts"
import { run } from "./utils.ts"

const budget: Change.Budget = {
	total: 10000,
	startup: 100,
	probe: 100,
	drain: 100,
	stop: 100,
	terminate: 100,
}
const candidate = (identity: string): Change.Candidate => ({
	driver: "restart",
	identity,
	deployment: identity,
})

class Value extends Context.Service<
	Value,
	{
		readonly read: Effect.Effect<
			string,
			| Transition.AdmissionRejected
			| Transition.DriverError
			| Transition.Unavailable
			| import("../src/Trust.ts").Unapproved
		>
	}
>()("@graftland/graft/test/change-restart.test/Value") {}

const setup = Effect.fnUntraced(function* (
	failCandidate: boolean = false,
	cleanup: Effect.Effect<void> = Effect.void,
	call: Effect.Effect<void> = Effect.void,
	resolve: (desired: Change.Candidate) => Change.Candidate = (desired) =>
		desired,
	wrongAcknowledgement: boolean = false,
) {
	const oldExit = yield* Deferred.make<Change.Termination>()
	const stopping = yield* Deferred.make<void>()
	const starts = yield* Ref.make<ReadonlyArray<number>>([])
	const resolved = yield* Ref.make<ReadonlyArray<string>>([])
	const driver: Transition.Driver = {
		name: "restart",
		footprint: (target) => target.deployment,
		allocate: (target, term, allocation) =>
			Effect.gen(function* () {
				if (term === 1) yield* Effect.addFinalizer(() => cleanup)
				const exited =
					term === 1 ? oldExit : yield* Deferred.make<Change.Termination>()
				return {
					acknowledgement:
						wrongAcknowledgement && term === 2
							? { ...allocation, generation: allocation.generation - 1 }
							: allocation,
					start: Ref.update(starts, Array.append(term)).pipe(
						Effect.andThen(
							term === 2 && failCandidate
								? Transition.DriverError.make({
										cause: Cause.fail("Candidate startup failed"),
									})
								: Effect.void,
						),
					),
					describe: Effect.succeed({ overlap: false, provides: [] }),
					serve: Effect.void,
					ready: Effect.succeed(
						Context.make(Value, {
							read: (term === 1 ? call : Effect.void).pipe(
								Effect.as(target.identity),
							),
						}),
					),
					probe: () => Effect.void,
					stop: Deferred.succeed(stopping, undefined).pipe(Effect.asVoid),
					terminate:
						term === 1
							? Effect.void
							: Deferred.succeed(exited, {
									unit: `unit-${term}`,
									state: "Exited",
								}).pipe(Effect.asVoid),
					exited: Deferred.await(exited),
					failure: Effect.never,
				}
			}),
	}
	const fork = yield* Graft.plugin(
		Plugin.make({
			name: "restart",
			apply: () =>
				Transition.registerDriver(driver, {
					instance: "a",
					initial: candidate("old"),
					budget,
					requirements: {},
					resolve: (desired) =>
						Ref.update(resolved, Array.append(desired.identity)).pipe(
							Effect.as(resolve(desired)),
						),
					queue: { maxWaiters: 1, maxWait: 50 },
					required: [],
					facades: [
						Transition.facade(Value, (invoke) => ({
							read: invoke((value) => value.read),
						})),
					],
				}),
		}),
	)
	yield* fork.await
	const value = yield* Deferred.make<Context.Service.Shape<typeof Value>>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "consumer",
			inject: [Value],
			apply: () =>
				Effect.flatMap(Value, (service) =>
					Deferred.succeed(value, service).pipe(Effect.asVoid),
				),
		}),
	)
	yield* consumer.await
	return {
		oldExit,
		stopping,
		starts,
		resolved,
		value: yield* Deferred.await(value),
	}
})

it.effect(
	"does not start a Restart candidate until old exit evidence arrives",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* setup()
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Deferred.await(h.stopping)
				const before = yield* Ref.get(h.starts)
				assert.deepStrictEqual(before, [1])
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Accepted")
				const after = yield* Ref.get(h.starts)
				assert.deepStrictEqual(after, [1, 2])
			}),
		),
)

it.effect(
	"bounds paused calls and removes cancelled and expired waiters exactly once",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* setup()
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Deferred.await(h.stopping)
				const queued = yield* h.value.read.pipe(
					Effect.forkScoped({ startImmediately: true }),
				)
				const overflow = yield* Effect.flip(h.value.read)
				assert.strictEqual(overflow._tag, "AdmissionRejected")
				yield* Fiber.interrupt(queued)
				const expiring = yield* Effect.flip(h.value.read).pipe(
					Effect.forkScoped({ startImmediately: true }),
				)
				yield* TestClock.adjust(50)
				const expired = yield* Fiber.join(expiring)
				assert.strictEqual(expired._tag, "AdmissionRejected")
				const waiting = yield* h.value.read.pipe(
					Effect.forkScoped({ startImmediately: true }),
				)
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				const selected = yield* Fiber.join(waiting)
				assert.strictEqual(selected, "next")
				yield* handle.await
			}),
		),
)

it.effect(
	"re-resolves the recovery target and completes its full trial after Restart startup failure",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* setup(true)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
					requirements: { trial: 100 },
				})
				yield* Deferred.await(h.stopping)
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				yield* Change.changes.pipe(
					Stream.filter(
						(status) => status.id === handle.id && status.phase === "Trial",
					),
					Stream.runHead,
				)
				const pending = yield* Change.get(handle.id)
				assert.isTrue(Option.isNone(Option.getOrThrow(pending).outcome))
				yield* TestClock.adjust(100)
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Recovered")
				const desired = yield* Ref.get(h.resolved)
				assert.deepStrictEqual(desired, ["old", "next", "old"])
			}),
		).pipe(Effect.provideService(Graft.Options, { maxUnits: 1 })),
)

it.effect(
	"reuses confirmed Restart capacity at maxUnits and rejects an unsupported Overlap",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* setup()
				const unsupported = yield* Effect.flip(
					Change.submit({
						instance: "a",
						candidate: candidate("next"),
						strategy: "Overlap",
						budget,
					}),
				)
				assert.strictEqual(unsupported.reason._tag, "Unsupported")
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Deferred.await(h.stopping)
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Accepted")
			}),
		).pipe(Effect.provideService(Graft.Options, { maxUnits: 1 })),
)

it.effect(
	"aborts explicit cancellation before the old stop boundary and leaves admitted calls alive",
	() =>
		run(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const h = yield* setup(
					false,
					Effect.void,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				)
				const call = yield* h.value.read.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const draining = yield* Change.changes.pipe(
					Stream.filter(
						(status) => status.instance === "a" && status.phase === "Draining",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Fiber.join(draining)
				yield* handle.cancel
				yield* handle.cancel
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Aborted")
				if (outcome._tag === "Aborted")
					assert.strictEqual(outcome.reason, "Cancelled")
				const stopped = yield* Deferred.isDone(h.stopping)
				assert.isFalse(stopped)
				yield* Deferred.succeed(release, undefined)
				const original = yield* Fiber.join(call)
				assert.strictEqual(original, "old")
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
			}),
		),
)

it.effect(
	"recovers after explicit cancellation crosses the old stop boundary",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* setup()
				const trial = yield* Change.changes.pipe(
					Stream.filter(
						(status) => status.instance === "a" && status.phase === "Trial",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
					requirements: { trial: 100 },
				})
				yield* Deferred.await(h.stopping)
				yield* handle.cancel
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				yield* Fiber.join(trial)
				yield* TestClock.adjust(100)
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Recovered")
				if (outcome._tag === "Recovered")
					assert.strictEqual(outcome.reason, "Cancelled")
				const resolved = yield* Ref.get(h.resolved)
				assert.deepStrictEqual(resolved, ["old", "old"])
			}),
		),
)

it.effect(
	"keeps a Stuck conclusion while late host cleanup settles and requires a fresh Change to restore service",
	() =>
		run(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const h = yield* setup(
					false,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Deferred.await(h.stopping)
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				yield* Deferred.await(entered)
				yield* TestClock.adjust(100)
				const stuck = yield* handle.await
				assert.strictEqual(stuck._tag, "Stuck")
				if (stuck._tag === "Stuck")
					assert.strictEqual(stuck.reason, "UnresolvedCleanup")
				const before = yield* Ref.get(h.starts)
				assert.deepStrictEqual(before, [1])
				const settled = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.id === handle.id &&
							Array.some(
								status.settlement,
								(fact) => fact.generation === 1 && fact.cleanup === "Completed",
							),
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(settled)
				const repeated = yield* handle.await
				assert.deepStrictEqual(repeated, stuck)
				const restored = yield* Change.run({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				assert.strictEqual(restored._tag, "Accepted")
			}),
		),
)

it.effect(
	"fences an acknowledgement from a different generation before startup and never reuses its term",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* setup(
					false,
					Effect.void,
					Effect.void,
					(desired) => desired,
					true,
				)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Deferred.await(h.stopping)
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Recovered")
				const starts = yield* Ref.get(h.starts)
				assert.deepStrictEqual(starts, [1, 3])
			}),
		),
)

it.effect(
	"rejects a resolved resource footprint change before allocating the candidate",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* setup(false, Effect.void, Effect.void, (desired) =>
					desired.identity === "next"
						? { ...desired, deployment: "different-placement" }
						: desired,
				)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Deferred.await(h.stopping)
				yield* Deferred.succeed(h.oldExit, { unit: "unit-1", state: "Exited" })
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Recovered")
				const starts = yield* Ref.get(h.starts)
				assert.deepStrictEqual(starts, [1, 3])
			}),
		),
)
