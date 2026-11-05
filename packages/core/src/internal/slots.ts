import { Effect, HashMap, Option, TxRef } from "effect"

import type { Runtime, ServiceKey, Slot } from "./runtime"

/** Call inside a transaction before waiting; the directory must stay out of waiting read sets. */
export const retain = Effect.fnUntraced(function* (
	runtime: Runtime,
	key: ServiceKey,
) {
	const directory = yield* TxRef.get(runtime.slots)
	const existing = HashMap.get(directory, key)
	if (Option.isSome(existing)) {
		yield* TxRef.update(existing.value.holders, (count) => count + 1)
		return existing.value
	}
	const slot: Slot = {
		key,
		provision: TxRef.makeUnsafe(Option.none()),
		holders: TxRef.makeUnsafe(1),
	}
	yield* TxRef.set(runtime.slots, HashMap.set(directory, key, slot))
	return slot
})

/** Every holder, including a publisher, releases in the same transaction as its last use. */
export const release = Effect.fnUntraced(function* (
	runtime: Runtime,
	slot: Slot,
) {
	const count = yield* TxRef.get(slot.holders)
	yield* TxRef.set(slot.holders, count - 1)
	if (count === 1) {
		const provision = yield* TxRef.get(slot.provision)
		if (Option.isNone(provision))
			yield* TxRef.update(runtime.slots, HashMap.remove(slot.key))
	}
})
