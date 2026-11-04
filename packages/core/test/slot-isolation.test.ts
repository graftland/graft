import { RuntimeContext } from "../src/internal/runtimeContext"
import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Option,
	Order,
	Stream,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { Graft, Plugin } from "../src/index.ts"
import * as Slots from "../src/internal/slots.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { reach, registrySnapshot, run } from "./utils.ts"

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
		"keeps the directory and unrelated forks out of pending and active wait read sets",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "consumer",
						inject: [Required],
						apply: () => Effect.void,
					}),
				)
				yield* reach(consumer, "Pending")
				const slots = yield* TxRef.get(runtime.slots)
				const slot = Option.getOrThrow(
					HashMap.get(slots, realmKey("", Required.key)),
				)
				yield* subscribed(slot.provision)
				assert.strictEqual(runtime.slots.pending.size, 0)
				const waiters = [...slot.provision.pending.keys()]
				const unrelated = yield* Graft.plugin(
					Plugin.service(Other, Effect.succeed(1), { name: "unrelated" }),
				)
				yield* unrelated.await
				yield* unrelated.restart
				yield* unrelated.await
				assert.deepStrictEqual([...slot.provision.pending.keys()], waiters)
				const provider = yield* Graft.plugin(
					Plugin.service(Required, Effect.succeed(1), { name: "provider" }),
				)
				yield* reach(consumer, "Active")
				yield* subscribed(slot.provision)
				assert.strictEqual(runtime.slots.pending.size, 0)
				yield* provider.dispose
				yield* reach(consumer, "Pending")
				const remaining = yield* TxRef.get(runtime.slots)
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(remaining, slot.key)),
					slot,
				)
				yield* consumer.dispose
				const released = yield* TxRef.get(runtime.slots)
				assert.isFalse(HashMap.has(released, slot.key))
			}).pipe(run),
	)

	it.effect(
		"rolls back new slots, publication and holder counts with an outer transaction",
		() =>
			Effect.gen(function* () {
				const { runtime, activation } = yield* RuntimeContext
				const failed = yield* Effect.exit(
					Effect.tx(
						Effect.gen(function* () {
							yield* Graft.provide(Required, 1)
							return yield* Effect.fail("rollback")
						}),
					),
				)
				assert.isTrue(Exit.isFailure(failed))
				const empty = yield* TxRef.get(runtime.slots)
				const published = yield* TxRef.get(activation.published)
				assert.strictEqual(HashMap.size(empty), 0)
				assert.deepStrictEqual(published, Option.some([]))
				yield* Graft.provide(Required, 2)
				const registry = yield* registrySnapshot(runtime)
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(registry, realmKey("", Required.key)))
						.value,
					2,
				)
			}).pipe(run),
	)

	it.effect(
		"does not leak a handle when publication failure is caught inside a transaction",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				yield* Graft.provide(Required, 1)
				const directory = yield* TxRef.get(runtime.slots)
				const slot = Option.getOrThrow(
					HashMap.get(directory, realmKey("", Required.key)),
				)
				const before = yield* TxRef.get(slot.holders)
				yield* Effect.tx(Effect.exit(Graft.provide(Required, 2)))
				const after = yield* TxRef.get(slot.holders)
				assert.strictEqual(after, before)
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
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "new consumer",
						inject: [Required],
						apply: () => Effect.void,
					}),
				)
				yield* reach(consumer, "Pending")
				const directory = yield* TxRef.get(runtime.slots)
				const current = Option.getOrThrow(HashMap.get(directory, key))
				assert.notStrictEqual(current, old)
				yield* Graft.plugin(
					Plugin.service(Required, Effect.succeed(1), { name: "new provider" }),
				)
				yield* reach(consumer, "Active")
			}).pipe(run),
	)

	it.effect(
		"serializes competing publications without replacing the winning provision",
		() =>
			Effect.gen(function* () {
				const left = yield* Graft.plugin(
					Plugin.service(Required, Effect.succeed(1), { name: "left" }),
				)
				const right = yield* Graft.plugin(
					Plugin.service(Required, Effect.succeed(2), { name: "right" }),
				)
				yield* Effect.exit(left.await)
				yield* Effect.exit(right.await)
				const states = yield* Effect.forEach([left, right], (fork) =>
					Stream.runHead(fork.state),
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
				const provider = yield* Graft.plugin(
					Plugin.service(Fallback, Effect.succeed(1), {
						name: "shadowing provider",
					}),
				)
				yield* provider.await
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "reference consumer",
						inject: [Fallback],
						apply: () =>
							Effect.gen(function* () {
								const value = yield* Fallback
								if (value === 9)
									yield* Deferred.succeed(fallbackReady, undefined)
							}),
					}),
				)
				yield* consumer.await
				assert.strictEqual(defaults, 0)
				yield* provider.dispose
				yield* Deferred.await(fallbackReady)
				assert.strictEqual(defaults, 1)
			}).pipe(run),
	)
	it.effect(
		"isolates failed publication retries and releases all of their handles",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const failed = yield* Graft.plugin(
					Plugin.make({
						name: "self dependency",
						inject: [Plugin.optional(Required)],
						apply: () => Graft.provide(Required, 1),
					}),
				)
				yield* reach(failed, "Failed")
				const entries = yield* TxSubscriptionRef.get(runtime.forks)
				const node = Option.getOrThrow(HashMap.get(entries, failed.id)).node
				yield* subscribed(node.state)
				const slots = yield* TxRef.get(runtime.slots)
				const slot = Option.getOrThrow(
					HashMap.get(slots, realmKey("", Required.key)),
				)
				assert.strictEqual(runtime.slots.pending.size, 0)
				const waiters = [...node.state.pending.keys()]
				const unrelated = yield* Graft.plugin(
					Plugin.service(Other, Effect.succeed(1), { name: "unrelated" }),
				)
				yield* unrelated.await
				yield* unrelated.restart
				yield* unrelated.await
				assert.deepStrictEqual([...node.state.pending.keys()], waiters)
				yield* failed.dispose
				const remaining = yield* TxRef.get(runtime.slots)
				const holders = yield* TxRef.get(slot.holders)
				assert.isFalse(HashMap.has(remaining, slot.key))
				assert.strictEqual(holders, 0)
			}).pipe(run),
	)
})
