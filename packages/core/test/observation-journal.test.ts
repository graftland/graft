import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	References,
	Scope,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import * as Snapshots from "../src/internal/snapshot.ts"
import { run } from "./utils.ts"

it.effect(
	"retains one ordered history for fast, slow, and native observers",
	() =>
		Effect.gen(function* () {
			const snapshot = yield* Snapshots.make(0)
			const fast = yield* Stream.toPull(Snapshots.changesStream(snapshot))
			const slow = yield* Stream.toPull(Snapshots.changesStream(snapshot))
			const queue = yield* Snapshots.changes(snapshot)
			const initialFast = yield* fast
			const initialSlow = yield* slow
			const initialNative = yield* Snapshots.take(queue)
			assert.deepStrictEqual(initialFast, [0])
			assert.deepStrictEqual(initialSlow, [0])
			assert.strictEqual(initialNative, 0)
			yield* Effect.tx(
				Effect.forEach([1, 2, 3], (value) => Snapshots.set(snapshot, value), {
					discard: true,
				}),
			)
			const first = yield* Effect.forEach([1, 2, 3], () => fast)
			const second = yield* Effect.forEach([1, 2, 3], () => slow)
			const third = yield* Effect.forEach([1, 2, 3], () =>
				Snapshots.take(queue),
			)
			assert.deepStrictEqual(first, [[1], [2], [3]])
			assert.deepStrictEqual(second, first)
			assert.deepStrictEqual(third, [1, 2, 3])
		}).pipe(Effect.scoped),
)

it.effect(
	"rolls back queued changes and releases the journal after its last reader",
	() =>
		Effect.gen(function* () {
			const snapshot = yield* Snapshots.make(0)
			yield* Snapshots.set(snapshot, 1)
			const unobserved = yield* Snapshots.getJournal(snapshot)
			assert.isUndefined(unobserved)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const pull = yield* Stream.toPull(Snapshots.changesStream(snapshot))
					const initial = yield* pull
					assert.deepStrictEqual(initial, [1])
					const rejected = yield* Effect.exit(
						Effect.tx(
							Snapshots.set(snapshot, 2).pipe(
								Effect.andThen(Effect.fail("rollback")),
							),
						),
					)
					assert.deepStrictEqual(rejected, Exit.fail("rollback"))
					yield* Snapshots.set(snapshot, 3)
					const committed = yield* pull
					assert.deepStrictEqual(committed, [3])
				}),
			)
			const released = yield* Snapshots.getJournal(snapshot)
			assert.isUndefined(released)
			yield* Snapshots.set(snapshot, 4)
			const replay = yield* Stream.runCollect(
				Snapshots.changesStream(snapshot).pipe(Stream.take(1)),
			)
			assert.deepStrictEqual(replay, [4])
		}),
)

it.effect("interrupts a retained pull when its subscription scope closes", () =>
	Effect.gen(function* () {
		const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
			Scope.close(scope, Exit.void),
		)
		const snapshot = yield* Snapshots.make(0)
		const pull = yield* Stream.toPull(Snapshots.changesStream(snapshot)).pipe(
			Scope.provide(scope),
		)
		yield* pull
		yield* Scope.close(scope, Exit.void)
		const result = yield* Effect.exit(pull)
		assert.isTrue(Exit.isFailure(result))
		if (Exit.isFailure(result))
			assert.isTrue(Cause.hasInterruptsOnly(result.cause))
	}).pipe(Effect.scoped),
)

it.effect("claims consecutive changes once across concurrent pulls", () =>
	Effect.gen(function* () {
		const snapshot = yield* Snapshots.make(0)
		const pull = yield* Stream.toPull(Snapshots.changesStream(snapshot))
		yield* pull
		yield* Effect.tx(
			Snapshots.set(snapshot, 1).pipe(
				Effect.andThen(Snapshots.set(snapshot, 2)),
			),
		)
		const readers = yield* Effect.forEach([0, 1], () => Effect.forkScoped(pull))
		const results = yield* Effect.forEach(readers, Fiber.join)
		assert.sameMembers(Array.flatten(results), [1, 2])
	}).pipe(Effect.scoped),
)

it.effect.each(Array.range(0, 30))(
	"registers the first observer atomically after %i yields",
	(ticks) =>
		Effect.gen(function* () {
			const snapshot = yield* Snapshots.make(0)
			const ready = yield* Deferred.make<number>()
			const reader = yield* Snapshots.changesStream(snapshot).pipe(
				Stream.tap((value) => Deferred.succeed(ready, value)),
				Stream.take(2),
				Stream.runCollect,
				Effect.provideService(References.MaxOpsBeforeYield, 4),
				Effect.forkScoped,
			)
			for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
			yield* Snapshots.set(snapshot, 1)
			const initial = yield* Deferred.await(ready)
			yield* Snapshots.set(snapshot, 2)
			const observed = yield* Fiber.join(reader)
			assert.deepStrictEqual(observed, initial === 0 ? [0, 1] : [1, 2])
		}).pipe(Effect.scoped),
)

it.effect(
	"observes a task failure while its inherited transaction remains open",
	() =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "open task transaction",
					apply: () =>
						Effect.tx(
							Effect.gen(function* () {
								yield* Plugin.fork(Effect.fail("task failure"))
								return yield* Effect.never
							}),
						),
				}),
			)
			const failed = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(failed))
			if (Exit.isFailure(failed))
				assert.include(Cause.pretty(failed.cause), "task failure")
			yield* fork.dispose
		}).pipe(run),
)
