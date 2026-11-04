import { Effect, HashMap, TxRef, TxSubscriptionRef } from "effect"
import { ForkState } from "../Fork"
import type { ForkStatus, LocalSnapshot, Runtime, Spec } from "./runtime"

/** Update ancestors in the same transaction as the state or topology change. */
const adjustLoading = Effect.fnUntraced(function* (
	status: ForkStatus | undefined,
	delta: number,
) {
	if (delta === 0) return
	for (let current = status; current !== undefined; current = current.parent) {
		const snapshot = yield* TxSubscriptionRef.get(current.snapshot)
		if (snapshot.disposed) return
		yield* TxRef.update(current.loading, (count) => count + delta)
	}
})

/** Called inside the fork registration transaction. */
export const make = Effect.fnUntraced(function* (
	parent: ForkStatus | undefined,
	spec: Spec,
) {
	const status: ForkStatus = {
		parent,
		loading: yield* TxRef.make(0),
		snapshot: yield* TxSubscriptionRef.make<LocalSnapshot>({
			state: ForkState.Loading(),
			accepted: undefined,
			name: spec.plugin.name,
			input: spec.input,
			disposed: false,
		}),
	}
	yield* adjustLoading(status, 1)
	return status
})

export const setState = Effect.fnUntraced(function* (
	runtime: Runtime,
	id: number,
	status: ForkStatus,
	state: ForkState,
	spec: Spec,
) {
	const current = yield* TxSubscriptionRef.get(status.snapshot)
	if (current.disposed) return
	const next: LocalSnapshot = {
		state,
		accepted: spec,
		name: spec.plugin.name,
		input: spec.input,
		disposed: false,
	}
	yield* adjustLoading(
		status,
		Number(state._tag === "Loading") - Number(current.state._tag === "Loading"),
	)
	yield* TxSubscriptionRef.set(status.snapshot, next)
	// Display snapshots contain values, so previously emitted trees never change.
	yield* TxSubscriptionRef.update(runtime.forks, (forks) =>
		HashMap.modify(forks, id, (entry) => ({ ...entry, ...next })),
	)
}, Effect.tx)

/** Called inside the removal transaction, after supervisor cleanup. */
export const dispose = Effect.fnUntraced(function* (
	runtime: Runtime,
	id: number,
	status: ForkStatus,
) {
	const current = yield* TxSubscriptionRef.get(status.snapshot)
	if (current.disposed) return
	const loading = yield* TxRef.get(status.loading)
	yield* adjustLoading(status.parent, -loading)
	yield* TxRef.set(status.loading, 0)
	yield* TxSubscriptionRef.set(status.snapshot, {
		...current,
		state: ForkState.Disposed(),
		disposed: true,
	})
	yield* TxSubscriptionRef.update(runtime.forks, HashMap.remove(id))
})

/** Only the subtree's own counter belongs to this waiting transaction's read set. */
export const stable: (status: ForkStatus) => Effect.Effect<void> =
	Effect.fnUntraced(function* (status: ForkStatus) {
		if ((yield* TxRef.get(status.loading)) > 0) return yield* Effect.txRetry
	}, Effect.tx)
