import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	MutableRef,
	Option,
	Stream,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition, Trust } from "../src/index.ts"
import * as ChangeTable from "../src/internal/changeTable.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { run } from "./utils.ts"

const candidate = (identity: string): Change.Candidate => ({
	driver: "fixture",
	identity,
	deployment: identity,
})
const budget: Change.Budget = {
	total: 10000,
	startup: 100,
	probe: 100,
	drain: 100,
	stop: 100,
	terminate: 100,
}

it.effect(
	"keeps keyed admission records after bounded observation history eviction",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("a")
				const request: Change.Request = {
					key: "durable-retry",
					instance: "a",
					expected: 1,
					candidate: candidate("first"),
					strategy: "Overlap",
					budget,
				}
				const first = yield* Change.submit(request)
				yield* first.await
				for (const n of Array.range(1, Change.historyLimit))
					yield* Change.run({
						instance: "a",
						candidate: candidate(`next-${n}`),
						strategy: "Overlap",
						budget,
					})
				const evicted = yield* Change.get(first.id)
				assert.isTrue(Option.isNone(evicted))
				const duplicate = yield* Change.submit(request)
				assert.strictEqual(duplicate.id, first.id)
			}),
		),
)

it.effect(
	"reads real affected object cells without probing unrelated tombstones",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("a")
				const { runtime } = yield* RuntimeContext
				const unrelated = MutableRef.make(0)
				const affected = MutableRef.make(0)
				for (const n of Array.range(0, 100)) {
					const key: Change.ObjectKey = {
						_tag: "Instance",
						instance: n === 0 ? "a" : `unrelated-${n}`,
					}
					const cell = yield* Effect.tx(
						ChangeTable.object(runtime.changes, key),
					)
					const counted = new Proxy(cell, {
						get(target, property, receiver) {
							if (property === "value")
								MutableRef.update(
									n === 0 ? affected : unrelated,
									(count) => count + 1,
								)
							return Reflect.get(target, property, receiver)
						},
					})
					yield* TxRef.update(runtime.changes.objects, (objects) =>
						HashMap.set(objects, key, counted),
					)
				}
				const result = yield* Change.run({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				assert.strictEqual(result._tag, "Accepted")
				assert.isAbove(MutableRef.get(affected), 0)
				assert.strictEqual(MutableRef.get(unrelated), 0)
			}),
		),
)

const register = Effect.fnUntraced(function* (
	instance: string,
	stuck: boolean = false,
	prepared: Effect.Effect<void> = Effect.void,
	prepare: Transition.Driver["prepare"] = undefined,
) {
	const ready = yield* Deferred.make<void>()
	const oldExit = yield* Deferred.make<Change.Termination>()
	const stopping = yield* Deferred.make<void>()
	const driver: Transition.Driver = {
		name: "fixture",
		prepare,
		overlap: () => true,
		allocate: (_candidate, term, allocation) =>
			Effect.gen(function* () {
				const exited =
					term === 1 ? oldExit : yield* Deferred.make<Change.Termination>()
				return {
					acknowledgement: allocation,
					start: Effect.void,
					describe: Effect.succeed({ overlap: true, provides: [] }),
					serve: Effect.void,
					ready: Deferred.succeed(ready, undefined).pipe(
						Effect.andThen(term === 1 ? Effect.void : prepared),
						Effect.as(Context.empty()),
					),
					probe: () => Effect.void,
					stop: Deferred.succeed(stopping, undefined).pipe(Effect.asVoid),
					terminate:
						stuck && term === 1
							? Effect.void
							: Deferred.succeed(exited, {
									unit: `${instance}-${term}`,
									state: "Exited",
								}).pipe(Effect.asVoid),
					exited: Deferred.await(exited),
					failure: Effect.never,
				}
			}),
	}
	const fork = yield* Graft.plugin(
		Plugin.make({
			name: instance,
			apply: () =>
				Transition.registerDriver(driver, {
					instance,
					initial: candidate("old"),
					required: [],
					facades: [],
					budget,
					requirements: { trial: 0, probes: [] },
				}),
		}),
	)
	yield* fork.await
	return { fork, ready, oldExit, stopping }
})

it.effect(
	"confines Stuck to A and preserves its conclusion after late exit evidence",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* register("a", true)
				yield* register("b")
				const a = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				yield* Deferred.await(h.stopping)
				yield* TestClock.adjust(100)
				const stuck = yield* a.await
				assert.strictEqual(stuck._tag, "Stuck")
				const conflict = yield* Effect.flip(
					Change.submit({
						instance: "a",
						candidate: candidate("other"),
						strategy: "Overlap",
						budget,
					}),
				)
				assert.strictEqual(conflict.reason._tag, "Busy")
				const b = yield* Change.run({
					instance: "b",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				assert.strictEqual(b._tag, "Accepted")
				yield* Deferred.succeed(h.oldExit, { unit: "a-1", state: "Exited" })
				const outcome = yield* a.await
				assert.deepStrictEqual(outcome, stuck)
			}),
		),
)

it.effect(
	"preserves both instance patches when Changes commit in reverse admission order",
	() =>
		run(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>()
				yield* register("a", false, Deferred.await(gate))
				yield* register("b")
				const a = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				const b = yield* Change.run({
					instance: "b",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				assert.strictEqual(b.members[0]?.actual.version, 2)
				yield* Deferred.succeed(gate, undefined)
				const done = yield* a.await
				assert.strictEqual(done.members[0]?.actual.version, 2)
				const observed = yield* Change.get(b.change)
				assert.strictEqual(
					Option.getOrThrow(observed).members[0]?.actual.version,
					2,
				)
			}),
		),
)

it.effect(
	"completes B while A retains its trial reservation and rejects only A conflicts",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("a")
				yield* register("b")
				const a = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
					requirements: { trial: 1000 },
				})
				const trial = yield* Change.changes.pipe(
					Stream.filter((s) => s.id === a.id && s.phase === "Trial"),
					Stream.runHead,
					Effect.forkScoped,
				)
				yield* Fiber.join(trial)
				const conflict = yield* Effect.flip(
					Change.submit({
						instance: "a",
						candidate: candidate("other"),
						strategy: "Overlap",
						budget,
					}),
				)
				assert.strictEqual(conflict.reason._tag, "Busy")
				const b = yield* Change.run({
					instance: "b",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				assert.strictEqual(b._tag, "Accepted")
				const waiting = yield* a.await.pipe(Effect.forkScoped)
				yield* Fiber.interrupt(waiting)
				const observed = yield* Change.get(a.id)
				assert.isTrue(Option.isSome(observed))
				yield* TestClock.adjust(1000)
				const accepted = yield* a.await
				assert.strictEqual(accepted._tag, "Accepted")
				const repeated = yield* a.await
				assert.deepStrictEqual(repeated, accepted)
			}),
		),
)

it.effect(
	"deduplicates keys before stale and busy checks and includes expected in KeyConflict",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("a")
				const request: Change.Request = {
					key: "retry",
					instance: "a",
					expected: 1,
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				}
				const first = yield* Change.submit(request)
				yield* first.await
				const repeated = yield* Change.submit(request)
				assert.strictEqual(repeated.id, first.id)
				const conflict = yield* Effect.flip(
					Change.submit({ ...request, expected: 2 }),
				)
				assert.strictEqual(conflict.reason._tag, "KeyConflict")
			}),
		),
)

it.effect(
	"prepares verified metadata before selecting Overlap and deduplicates before preparation",
	() =>
		run(
			Effect.gen(function* () {
				const preparations = yield* TxRef.make(0)
				yield* register("a", false, Effect.void, () =>
					TxRef.update(preparations, (n) => n + 1).pipe(
						Effect.as({ overlap: false }),
					),
				)
				const unsupported = yield* Effect.flip(
					Change.submit({
						instance: "a",
						candidate: candidate("next"),
						strategy: "Overlap",
						budget,
					}),
				)
				assert.strictEqual(unsupported.reason._tag, "Unsupported")
				const request: Change.Request = {
					key: "prepared",
					instance: "a",
					candidate: candidate("next"),
					budget,
				}
				const handle = yield* Change.submit(request)
				const result = yield* handle.await
				assert.strictEqual(result._tag, "Accepted")
				const duplicate = yield* Change.submit(request)
				assert.strictEqual(duplicate.id, handle.id)
				const count = yield* TxRef.get(preparations)
				assert.strictEqual(count, 2)
			}),
		),
)

it.effect(
	"detects authorization ABA before cutover without invalidating an unrelated Change",
	() =>
		run(
			Effect.gen(function* () {
				const revision = yield* TxRef.make(0)
				yield* Trust.register({
					compare: (entry) =>
						TxRef.get(revision).pipe(
							Effect.map((revision) => ({
								revision: entry === "a" ? revision : 0,
								current: "approved",
								approved: Option.some("approved"),
								missing: "Missing",
							})),
						),
					publish: () => Effect.void,
				})
				const entered = yield* Deferred.make<void>()
				const gate = yield* Deferred.make<void>()
				yield* register(
					"a",
					false,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(gate)),
					),
				)
				yield* register("b")
				const a = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				yield* Deferred.await(entered)
				yield* Effect.tx(TxRef.update(revision, (n) => n + 2))
				const b = yield* Change.run({
					instance: "b",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				assert.strictEqual(b._tag, "Accepted")
				yield* Deferred.succeed(gate, undefined)
				const aborted = yield* a.await
				assert.strictEqual(aborted._tag, "Aborted")
				if (aborted._tag === "Aborted")
					assert.strictEqual(aborted.reason, "Stale")
			}),
		),
)

it.effect(
	"retains metadata cleanup ownership after its deadline and releases only after its original completion",
	() =>
		run(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				yield* register("a", false, Effect.void, () =>
					Effect.addFinalizer(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					).pipe(Effect.as({ overlap: true })),
				)
				yield* register("b")
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Deferred.await(entered)
				yield* TestClock.adjust(100)
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Stuck")
				const rejected = yield* Effect.flip(
					Change.submit({
						instance: "a",
						candidate: candidate("other"),
						budget,
					}),
				)
				assert.strictEqual(rejected.reason._tag, "Busy")
				const b = yield* Change.run({
					instance: "b",
					candidate: candidate("next"),
					budget,
				})
				assert.strictEqual(b._tag, "Accepted")
				const settled = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.id === handle.id &&
							status.preparation?.cleanup === "Completed",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(settled)
				const repeated = yield* handle.await
				assert.deepStrictEqual(repeated, outcome)
				const { runtime } = yield* RuntimeContext
				const pending = yield* TxRef.get(runtime.changes.preparations)
				assert.strictEqual(HashSet.size(pending), 0)
			}),
		),
)

it.effect(
	"never re-grants a term when an instance name is registered again",
	() =>
		run(
			Effect.gen(function* () {
				const first = yield* register("a")
				yield* first.fork.dispose
				const second = yield* register("a")
				const generations = yield* second.fork.generations.pipe(Stream.runHead)
				assert.strictEqual(Option.getOrThrow(generations)[0]?.attempt, 2)
			}),
		),
)
