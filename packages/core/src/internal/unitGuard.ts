import { Effect, HashMap, Option } from "effect"

import { ManagedFork } from "../Transition"
import type { ForkEntry, Runtime } from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import * as Snapshots from "./snapshot"

const contains = (
	forks: HashMap.HashMap<number, ForkEntry>,
	entry: ForkEntry,
	id: number,
): boolean =>
	entry.id === id ||
	(entry.parent !== undefined &&
		Option.exists(HashMap.get(forks, entry.parent), (parent) =>
			contains(forks, parent, id),
		))
/** Called in the transaction that admits a cooperative mutation. */
export const check = Effect.fnUntraced(function* (
	runtime: Runtime,
	id?: number,
) {
	const forks = yield* Snapshots.get(runtime.forks)
	for (const entry of HashMap.values(forks))
		if (
			entry.status.unitOwned &&
			(id === undefined || contains(forks, entry, id))
		)
			return yield* ManagedFork.make({ fork: entry.id })
})
export const assertUnmanaged = Effect.fnUntraced(function* (id?: number) {
	const { runtime } = yield* RuntimeContext
	yield* Effect.tx(check(runtime, id))
})
export const withUnmanaged = Effect.fnUntraced(function* <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	id?: number,
) {
	yield* assertUnmanaged(id)
	return yield* effect
})
