import {
	Array,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Order,
	Stream,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import * as Slots from "../src/internal/slots.ts"
import { reach, registrySnapshot, run } from "./b1c-utils.ts"

class Required extends Context.Service<Required, number>()(
	"@graftland/graft/test/slot-isolation.test/Required",
) {}
class Other extends Context.Service<Other, number>()(
	"@graftland/graft/test/slot-isolation.test/Other",
) {}

/** Wait for the supervisor's transaction to subscribe, without relying on elapsed time. */
const subscribed = <A>(ref: TxRef.TxRef<A>): Effect.Effect<void> =>
	Effect.suspend(() =>
		ref.pending.size > 0
			? Effect.void
			: Effect.andThen(Effect.yieldNow, subscribed(ref)),
	)

describe("transactional service slots", () => {
	it.effect(
		"keeps the directory and unrelated mounts out of pending and active wait read sets",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const consumer = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "consumer",
					requires: [Required],
				})
				yield* reach(consumer, "Pending")
				const slots = yield* TxRef.get(runtime.slots)
				const slot = Option.getOrThrow(
					HashMap.get(slots, realmKey("", Required.key)),
				)
				yield* subscribed(slot.provision)
				assert.strictEqual(runtime.slots.pending.size, 0)
				const waiters = [...slot.provision.pending.keys()]
				const unrelated = yield* Graft.mount(Layer.succeed(Other, 1), {
					name: "unrelated",
				})
				yield* unrelated.await
				yield* unrelated.restart
				yield* unrelated.await
				assert.deepStrictEqual([...slot.provision.pending.keys()], waiters)
				const provider = yield* Graft.mount(Layer.succeed(Required, 1), {
					name: "provider",
				})
				yield* reach(consumer, "Active")
				yield* subscribed(slot.provision)
				assert.strictEqual(runtime.slots.pending.size, 0)
				yield* provider.unmount
				yield* reach(consumer, "Pending")
				const remaining = yield* TxRef.get(runtime.slots)
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(remaining, slot.key)),
					slot,
				)
				yield* consumer.unmount
				const released = yield* TxRef.get(runtime.slots)
				assert.isFalse(HashMap.has(released, slot.key))
			}).pipe(run),
	)

	it.effect("rolls back retained slots with an outer transaction", () =>
		Effect.gen(function* () {
			const { runtime, activation } = yield* RuntimeContext
			const failed = yield* Effect.exit(
				Effect.tx(
					Effect.gen(function* () {
						yield* Slots.retain(runtime, realmKey("", Required.key))
						return yield* Effect.fail("rollback")
					}),
				),
			)
			assert.isTrue(Exit.isFailure(failed))
			const empty = yield* TxRef.get(runtime.slots)
			const published = yield* TxRef.get(activation.published)
			assert.strictEqual(HashMap.size(empty), 0)
			assert.deepStrictEqual(published, Option.some([]))
			const provider = yield* Graft.mount(Layer.succeed(Required, 2), {
				name: "provider",
			})
			yield* provider.await
			const registry = yield* registrySnapshot(runtime)
			assert.strictEqual(
				Option.getOrThrow(HashMap.get(registry, realmKey("", Required.key)))
					.value,
				2,
			)
		}).pipe(run),
	)

	it.effect(
		"releases a failed competing publication's handle when it is unmounted",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const first = yield* Graft.mount(Layer.succeed(Required, 1), {
					name: "first",
				})
				yield* first.await
				const directory = yield* TxRef.get(runtime.slots)
				const slot = Option.getOrThrow(
					HashMap.get(directory, realmKey("", Required.key)),
				)
				const second = yield* Graft.mount(Layer.succeed(Required, 2), {
					name: "second",
				})
				yield* reach(second, "Failed")
				const before = yield* TxRef.get(slot.holders)
				yield* second.unmount
				const after = yield* TxRef.get(slot.holders)
				assert.strictEqual(before, 1)
				assert.strictEqual(after, 1)
				yield* first.unmount
				const remaining = yield* TxRef.get(runtime.slots)
				assert.isFalse(HashMap.has(remaining, slot.key))
			}).pipe(run),
	)

	it.effect(
		"recreates released keys and wakes their new pending consumers",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const key = realmKey("", Required.key)
				const old = yield* Effect.tx(Slots.retain(runtime, key))
				yield* Effect.tx(Slots.release(runtime, old))
				const consumer = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "new consumer",
					requires: [Required],
				})
				yield* reach(consumer, "Pending")
				const directory = yield* TxRef.get(runtime.slots)
				const current = Option.getOrThrow(HashMap.get(directory, key))
				assert.notStrictEqual(current, old)
				yield* Graft.mount(Layer.succeed(Required, 1), { name: "new provider" })
				yield* reach(consumer, "Active")
			}).pipe(run),
	)

	it.effect(
		"serializes competing publications without replacing the winning provision",
		() =>
			Effect.gen(function* () {
				const left = yield* Graft.mount(Layer.succeed(Required, 1), {
					name: "left",
				})
				const right = yield* Graft.mount(Layer.succeed(Required, 2), {
					name: "right",
				})
				yield* Effect.exit(left.await)
				yield* Effect.exit(right.await)
				const states = yield* Effect.forEach([left, right], (mount) =>
					Stream.runHead(mount.state),
				)
				assert.deepStrictEqual(
					Array.sort(
						Array.map(states, (state) => Option.getOrThrow(state)._tag),
						Order.String,
					),
					["Active", "Failed"],
				)
				const { runtime } = yield* RuntimeContext
				const registry = yield* registrySnapshot(runtime)
				assert.strictEqual(HashMap.size(registry), 1)
			}).pipe(run),
	)
	it.effect(
		"does not evaluate a reference fallback while a provision shadows it",
		() =>
			Effect.gen(function* () {
				let defaults = 0
				const Fallback = Context.Reference<number>(
					"@graftland/graft/test/slot-isolation.test/Fallback",
					{
						defaultValue: () => {
							defaults++
							return 9
						},
					},
				)
				const fallbackReady = yield* Deferred.make<void>()
				const provider = yield* Graft.mount(Layer.succeed(Fallback, 1), {
					name: "shadowing provider",
				})
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const value = yield* Fallback
							if (value === 9) yield* Deferred.succeed(fallbackReady, undefined)
						}),
					),
					{ name: "reference consumer", requires: [Fallback] },
				)
				yield* consumer.await
				assert.strictEqual(defaults, 0)
				yield* provider.unmount
				yield* Deferred.await(fallbackReady)
				assert.strictEqual(defaults, 1)
			}).pipe(run),
	)
	it.effect(
		"isolates failed publication retries and releases all of their handles",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const failed = yield* Graft.mount(Layer.succeed(Required, 1), {
					name: "self dependency",
					requires: [Graft.optional(Required)],
				})
				yield* reach(failed, "Failed")
				const entries = yield* TxSubscriptionRef.get(runtime.mounts)
				const node = Option.getOrThrow(HashMap.get(entries, failed.id)).node
				yield* subscribed(node.state)
				const slots = yield* TxRef.get(runtime.slots)
				const slot = Option.getOrThrow(
					HashMap.get(slots, realmKey("", Required.key)),
				)
				assert.strictEqual(runtime.slots.pending.size, 0)
				const waiters = [...node.state.pending.keys()]
				const unrelated = yield* Graft.mount(Layer.succeed(Other, 1), {
					name: "unrelated",
				})
				yield* unrelated.await
				yield* unrelated.restart
				yield* unrelated.await
				assert.deepStrictEqual([...node.state.pending.keys()], waiters)
				yield* failed.unmount
				const remaining = yield* TxRef.get(runtime.slots)
				const holders = yield* TxRef.get(slot.holders)
				assert.isFalse(HashMap.has(remaining, slot.key))
				assert.strictEqual(holders, 0)
			}).pipe(run),
	)
})
