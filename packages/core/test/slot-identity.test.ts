import { Context, Effect, HashMap, Layer, Option, TxRef } from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import * as Slots from "../src/internal/slots.ts"
import { registrySnapshot, run } from "./b1c-utils.ts"

class Required extends Context.Service<Required, number>()(
	"@graftland/graft/test/slot-identity.test/Required",
) {}

describe("slot identity", () => {
	it.effect("counts holders and removes the slot after the last release", () =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const key = realmKey("", Required.key)
			const first = yield* Effect.tx(Slots.retain(runtime, key))
			const second = yield* Effect.tx(Slots.retain(runtime, key))
			assert.strictEqual(second, first)
			const two = yield* TxRef.get(first.holders)
			assert.strictEqual(two, 2)
			yield* Effect.tx(Slots.release(runtime, first))
			const one = yield* TxRef.get(first.holders)
			assert.strictEqual(one, 1)
			const kept = yield* TxRef.get(runtime.slots)
			assert.strictEqual(Option.getOrThrow(HashMap.get(kept, key)), first)
			yield* Effect.tx(Slots.release(runtime, second))
			const zero = yield* TxRef.get(first.holders)
			assert.strictEqual(zero, 0)
			const removed = yield* TxRef.get(runtime.slots)
			assert.isFalse(HashMap.has(removed, key))
		}).pipe(run),
	)

	it.effect("ignores a stale release when a newer slot holds the key", () =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const key = realmKey("", Required.key)
			const stale = yield* Effect.tx(Slots.retain(runtime, key))
			// Install a replacement while the stale slot still counts this holder.
			const current = yield* Effect.tx(
				Effect.gen(function* () {
					yield* TxRef.update(runtime.slots, HashMap.remove(key))
					return yield* Slots.retain(runtime, key)
				}),
			)
			assert.notStrictEqual(current, stale)
			yield* Effect.tx(Slots.release(runtime, stale))
			const directory = yield* TxRef.get(runtime.slots)
			assert.strictEqual(
				Option.getOrThrow(HashMap.get(directory, key)),
				current,
			)
			const holders = yield* TxRef.get(current.holders)
			assert.strictEqual(holders, 1)
			const provision = yield* TxRef.get(current.provision)
			assert.isTrue(Option.isNone(provision))
			yield* Effect.tx(Slots.release(runtime, current))
			const removed = yield* TxRef.get(runtime.slots)
			assert.isFalse(HashMap.has(removed, key))
		}).pipe(run),
	)

	it.effect(
		"keeps the new generation's slot and provision after a stale release",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const key = realmKey("", Required.key)
				const stale = yield* Effect.tx(Slots.retain(runtime, key))
				const current = yield* Effect.tx(
					Effect.gen(function* () {
						yield* TxRef.update(runtime.slots, HashMap.remove(key))
						return yield* Slots.retain(runtime, key)
					}),
				)
				const provider = yield* Graft.mount(Layer.succeed(Required, 2), {
					name: "replacement provider",
				})
				yield* provider.await
				const during = yield* TxRef.get(runtime.slots)
				assert.strictEqual(Option.getOrThrow(HashMap.get(during, key)), current)
				const holders = yield* TxRef.get(current.holders)
				assert.strictEqual(holders, 2)
				const initial = yield* registrySnapshot(runtime)
				const published = Option.getOrThrow(HashMap.get(initial, key))
				assert.strictEqual(published.value, 2)

				yield* Effect.tx(Slots.release(runtime, stale))

				const retained = yield* TxRef.get(runtime.slots)
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(retained, key)),
					current,
				)
				const provision = yield* TxRef.get(current.provision)
				assert.strictEqual(Option.getOrThrow(provision), published)
				const registry = yield* registrySnapshot(runtime)
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(registry, key)).value,
					2,
				)
			}).pipe(run),
	)

	it.effect("withdraws a real provider and removes its released slot", () =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const key = realmKey("", Required.key)
			const provider = yield* Graft.mount(Layer.succeed(Required, 3), {
				name: "provider",
			})
			yield* provider.await
			const directory = yield* TxRef.get(runtime.slots)
			const slot = Option.getOrThrow(HashMap.get(directory, key))
			const before = yield* TxRef.get(slot.holders)
			assert.strictEqual(before, 1)
			const provision = yield* TxRef.get(slot.provision)
			assert.isTrue(Option.isSome(provision))
			yield* provider.unmount
			const after = yield* TxRef.get(slot.holders)
			assert.strictEqual(after, 0)
			const released = yield* TxRef.get(runtime.slots)
			assert.isFalse(HashMap.has(released, key))
		}).pipe(run),
	)
})
