import { RuntimeContext } from "../src/internal/runtimeContext"
import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	Option,
	Schema,
	Stream,
	TxQueue,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { Fork, Graft, Plugin } from "../src/index.ts"
import { reach, run } from "./utils.ts"
import { setState } from "../src/internal/forkState.ts"

const entryOf = Effect.fnUntraced(function* (fork: Fork.Fork) {
	const { runtime } = yield* RuntimeContext
	const entries = yield* TxSubscriptionRef.get(runtime.forks)
	return Option.getOrThrow(HashMap.get(entries, fork.id))
})

class Missing extends Context.Service<Missing, string>()(
	"@graftland/graft/test/fork-local-state.test/Missing",
) {}

describe("fork-local state", () => {
	it.effect(
		"does not notify a local subscriber when an unrelated fork changes",
		() =>
			Effect.gen(function* () {
				const definition = Plugin.make({
					name: "independent",
					apply: () => Effect.void,
				})
				const first = yield* Graft.plugin(definition)
				yield* first.await
				const entry = yield* entryOf(first)
				const changes = yield* TxSubscriptionRef.changes(entry.status.snapshot)
				const initial = yield* TxQueue.take(changes)
				assert.strictEqual(initial.state._tag, "Active")
				const second = yield* Graft.plugin(definition)
				yield* second.await
				yield* second.restart
				yield* second.await
				yield* second.dispose
				const changed = yield* TxQueue.poll(changes)
				assert.isTrue(Option.isNone(changed))
			}).pipe(run),
	)

	it.effect(
		"accepts a new input while Active without emitting a duplicate public state",
		() =>
			Effect.gen(function* () {
				const subscribed = yield* Deferred.make<void>()
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "in-place update",
						config: Schema.String,
						apply: () => Effect.succeed(() => Effect.succeed(true)),
					}),
					"initial",
				)
				yield* fork.await
				const states = yield* fork.state.pipe(
					Stream.tap(() => Deferred.succeed(subscribed, undefined)),
					Stream.runCollect,
					Effect.forkScoped,
				)
				yield* Deferred.await(subscribed)
				const entry = yield* entryOf(fork)
				const previous = yield* TxSubscriptionRef.get(entry.status.snapshot)
				yield* fork.update("updated")
				const next = yield* TxSubscriptionRef.get(entry.status.snapshot)
				assert.strictEqual(next.state._tag, "Active")
				assert.notStrictEqual(next.accepted, previous.accepted)
				assert.strictEqual(next.accepted?.input, "updated")
				yield* fork.dispose
				const observed = yield* Fiber.join(states)
				assert.deepStrictEqual(
					Array.map(observed, (state) => state._tag),
					["Active", "Disposed"],
				)
			}).pipe(run),
	)

	it.effect("replays Disposed and ends for a late subscriber", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({ name: "short-lived", apply: () => Effect.void }),
			)
			yield* fork.await
			yield* fork.dispose
			const states = yield* Stream.runCollect(fork.state)
			assert.deepStrictEqual(states, [Fork.ForkState.Disposed()])
			yield* fork.update(undefined)
			yield* fork.stable
		}).pipe(run),
	)

	it.effect(
		"keeps historical tree snapshots unchanged after an accepted update",
		() =>
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "snapshot input",
						config: Schema.String,
						apply: () => Effect.succeed(() => Effect.succeed(true)),
					}),
					"before",
				)
				yield* fork.await
				const before = yield* Stream.runHead(Graft.forks)
				yield* fork.update("after")
				const after = yield* Stream.runHead(Graft.forks)
				assert.strictEqual(Option.getOrThrow(before)[0]?.input, "before")
				assert.strictEqual(Option.getOrThrow(after)[0]?.input, "after")
			}).pipe(run),
	)
	it.effect("groups roots and children in increasing fork order", () =>
		Effect.gen(function* () {
			const group = Plugin.make({
				name: "wide parent",
				apply: () =>
					Effect.forEach(
						Array.range(1, 8),
						(id) =>
							Graft.plugin(
								Plugin.make({ name: `child ${id}`, apply: () => Effect.void }),
							),
						{ discard: true },
					),
			})
			const first = yield* Graft.plugin(group)
			yield* first.stable
			const second = yield* Graft.plugin(group)
			yield* second.stable
			const snapshot = yield* Stream.runHead(Graft.forks)
			const roots = Option.getOrThrow(snapshot)
			assert.deepStrictEqual(
				Array.map(roots, (node) => node.id),
				[first.id, second.id],
			)
			for (const root of roots) {
				assert.deepStrictEqual(
					Array.map(root.children, (node) => node.id),
					Array.range(root.id + 1, root.id + 8),
				)
			}
		}).pipe(run),
	)
})

describe("subtree stability", () => {
	it.effect(
		"waits for loading descendants after their ancestors are Active",
		() =>
			Effect.gen(function* () {
				const release = yield* Deferred.make<void>()
				const child = Plugin.make({
					name: "loading child",
					apply: () => Deferred.await(release),
				})
				const middle = Plugin.make({
					name: "middle",
					apply: () => Graft.plugin(child).pipe(Effect.asVoid),
				})
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "parent",
						apply: () =>
							Graft.plugin(middle).pipe(Effect.flatMap((fork) => fork.await)),
					}),
				)
				yield* parent.await
				const entry = yield* entryOf(parent)
				const loading = yield* TxRef.get(entry.status.loading)
				assert.strictEqual(loading, 1)
				const waiting = yield* Effect.forkScoped(parent.stable)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(waiting)
				const settled = yield* TxRef.get(entry.status.loading)
				assert.strictEqual(settled, 0)
			}).pipe(run),
	)

	it.effect(
		"treats Pending and Failed descendants as settled and reads only its own counter",
		() =>
			Effect.gen(function* () {
				const pending = Plugin.make({
					name: "pending child",
					inject: [Missing],
					apply: () => Effect.void,
				})
				const failed = Plugin.make({
					name: "failed child",
					apply: () => Effect.fail("expected failure"),
				})
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "settled parent",
						apply: () =>
							Effect.gen(function* () {
								const pendingFork = yield* Graft.plugin(pending)
								const failedFork = yield* Graft.plugin(failed)
								yield* reach(pendingFork, "Pending")
								yield* reach(failedFork, "Failed")
							}),
					}),
				)
				yield* parent.await
				const entry = yield* entryOf(parent)
				const reads = yield* Effect.tx(
					Effect.gen(function* () {
						yield* parent.stable
						const transaction = yield* Effect.Transaction
						return Array.fromIterable(transaction.journal.keys())
					}),
				)
				assert.deepStrictEqual(reads, [entry.status.loading])
			}).pipe(run),
	)

	it.effect(
		"rolls back local state, display state and ancestor counts together",
		() =>
			Effect.gen(function* () {
				const handle = yield* Deferred.make<Fork.Fork>()
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "transactional parent",
						apply: () =>
							Effect.gen(function* () {
								const child = yield* Graft.plugin(
									Plugin.make({
										name: "transactional child",
										apply: () => Effect.never,
									}),
								)
								yield* Deferred.succeed(handle, child)
							}),
					}),
				)
				yield* parent.await
				const child = yield* Deferred.await(handle)
				const parentEntry = yield* entryOf(parent)
				const childEntry = yield* entryOf(child)
				const { runtime } = yield* RuntimeContext
				const spec = yield* TxRef.get(childEntry.spec)
				const before = yield* TxSubscriptionRef.get(childEntry.status.snapshot)
				yield* Effect.tx(
					setState(
						runtime,
						child.id,
						childEntry.status,
						Fork.ForkState.Active(),
						spec,
					).pipe(Effect.andThen(Effect.fail("roll back"))),
				).pipe(Effect.flip)
				const after = yield* TxSubscriptionRef.get(childEntry.status.snapshot)
				const count = yield* TxRef.get(parentEntry.status.loading)
				const display = yield* entryOf(child)
				assert.strictEqual(after, before)
				assert.strictEqual(count, 1)
				assert.strictEqual(display.state._tag, "Loading")
			}).pipe(run),
	)

	it.effect("updates ancestor counts when a Loading child is disposed", () =>
		Effect.gen(function* () {
			const handle = yield* Deferred.make<Fork.Fork>()
			const parent = yield* Graft.plugin(
				Plugin.make({
					name: "parent of cancelled child",
					apply: () =>
						Effect.gen(function* () {
							const child = yield* Graft.plugin(
								Plugin.make({
									name: "cancelled child",
									apply: () => Effect.never,
								}),
							)
							yield* Deferred.succeed(handle, child)
						}),
				}),
			)
			yield* parent.await
			const child = yield* Deferred.await(handle)
			const entry = yield* entryOf(parent)
			const loading = yield* TxRef.get(entry.status.loading)
			assert.strictEqual(loading, 1)
			yield* child.dispose
			yield* parent.stable
			const settled = yield* TxRef.get(entry.status.loading)
			assert.strictEqual(settled, 0)
		}).pipe(run),
	)
})
