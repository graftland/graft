import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	Layer,
	Option,
	Stream,
	TxQueue,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { setState } from "../src/internal/mountStatus.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { reach, run } from "./utils.ts"

const entryOf = Effect.fnUntraced(function* (mount: Mount.Mount) {
	const { runtime } = yield* RuntimeContext
	const entries = yield* TxSubscriptionRef.get(runtime.mounts)
	return Option.getOrThrow(HashMap.get(entries, mount.id))
})

class Missing extends Context.Service<Missing, string>()(
	"@graftland/graft/test/fork-local-state.test/Missing",
) {}

describe("mount-local state", () => {
	it.effect(
		"does not notify a local subscriber when an unrelated mount changes",
		() =>
			Effect.gen(function* () {
				const definition = Layer.effectDiscard(Effect.void)
				const first = yield* Graft.mount(definition, { name: "independent" })
				yield* first.await
				const entry = yield* entryOf(first)
				const changes = yield* TxSubscriptionRef.changes(entry.status.snapshot)
				const initial = yield* TxQueue.take(changes)
				assert.strictEqual(initial.state._tag, "Active")
				const second = yield* Graft.mount(definition, { name: "independent" })
				yield* second.await
				yield* second.restart
				yield* second.await
				yield* second.unmount
				const changed = yield* TxQueue.poll(changes)
				assert.isTrue(Option.isNone(changed))
			}).pipe(run),
	)

	it.effect("replays Unmounted and ends for a late subscriber", () =>
		Effect.gen(function* () {
			const mount = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
				name: "short-lived",
			})
			yield* mount.await
			yield* mount.unmount
			const states = yield* Stream.runCollect(mount.state)
			assert.deepStrictEqual(states, [Mount.MountState.Unmounted()])
			yield* mount.stable
		}).pipe(run),
	)

	it.effect("groups roots and children in increasing mount order", () =>
		Effect.gen(function* () {
			const group = Layer.effectDiscard(
				Effect.forEach(
					Array.range(1, 8),
					(id) =>
						Graft.mount(Layer.effectDiscard(Effect.void), {
							name: `child ${id}`,
						}),
					{ discard: true },
				),
			)
			const first = yield* Graft.mount(group, { name: "wide parent" })
			yield* first.stable
			const second = yield* Graft.mount(group, { name: "wide parent" })
			yield* second.stable
			const snapshot = yield* Stream.runHead(Graft.mounts)
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
				const child = Layer.effectDiscard(Deferred.await(release))
				const middle = Layer.effectDiscard(
					Graft.mount(child, { name: "loading child" }).pipe(Effect.asVoid),
				)
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Graft.mount(middle, { name: "middle" }).pipe(
							Effect.flatMap((mount) => mount.await),
						),
					),
					{ name: "parent" },
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
				const pending = Layer.effectDiscard(Effect.void)
				const failed = Layer.effectDiscard(Effect.fail("expected failure"))
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const pendingMount = yield* Graft.mount(pending, {
								name: "pending child",
								requires: [Missing],
							})
							const failedMount = yield* Graft.mount(failed, {
								name: "failed child",
							})
							yield* reach(pendingMount, "Pending")
							yield* reach(failedMount, "Failed")
						}),
					),
					{ name: "settled parent" },
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
				const handle = yield* Deferred.make<Mount.Mount>()
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const child = yield* Graft.mount(
								Layer.effectDiscard(Effect.never),
								{ name: "transactional child" },
							)
							yield* Deferred.succeed(handle, child)
						}),
					),
					{ name: "transactional parent" },
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
						Mount.MountState.Active(),
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

	it.effect("updates ancestor counts when a Loading child is unmounted", () =>
		Effect.gen(function* () {
			const handle = yield* Deferred.make<Mount.Mount>()
			const parent = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const child = yield* Graft.mount(
							Layer.effectDiscard(Effect.never),
							{ name: "cancelled child" },
						)
						yield* Deferred.succeed(handle, child)
					}),
				),
				{ name: "parent of cancelled child" },
			)
			yield* parent.await
			const child = yield* Deferred.await(handle)
			const entry = yield* entryOf(parent)
			const loading = yield* TxRef.get(entry.status.loading)
			assert.strictEqual(loading, 1)
			yield* child.unmount
			yield* parent.stable
			const settled = yield* TxRef.get(entry.status.loading)
			assert.strictEqual(settled, 0)
		}).pipe(run),
	)
})
