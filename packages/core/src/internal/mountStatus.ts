import { Effect, HashMap, TxRef, TxSubscriptionRef } from "effect"

import { MountState } from "../Mount"
import type { LocalSnapshot, MountStatus, Runtime, Spec } from "./runtime"

/** Update ancestors in the same transaction as the state or topology change. */
const adjustLoading = Effect.fnUntraced(function* (
	status: MountStatus | undefined,
	delta: number,
) {
	if (delta === 0) return
	for (let current = status; current !== undefined; current = current.parent) {
		const snapshot = yield* TxSubscriptionRef.get(current.snapshot)
		if (snapshot.disposed) return
		yield* TxRef.update(current.loading, (count) => count + delta)
	}
})

/** Called inside the mount registration transaction. */
export const make = Effect.fnUntraced(function* (
	parent: MountStatus | undefined,
	spec: Spec,
) {
	const status: MountStatus = {
		parent,
		loading: yield* TxRef.make(0),
		snapshot: yield* TxSubscriptionRef.make<LocalSnapshot>({
			state: MountState.Loading(),
			accepted: undefined,
			name: spec.definition.name,
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
	status: MountStatus,
	state: MountState,
	spec: Spec,
) {
	const current = yield* TxSubscriptionRef.get(status.snapshot)
	if (current.disposed) return
	const next: LocalSnapshot = {
		state,
		accepted: spec,
		name: spec.definition.name,
		input: spec.input,
		disposed: false,
	}
	yield* adjustLoading(
		status,
		Number(state._tag === "Loading") - Number(current.state._tag === "Loading"),
	)
	yield* TxSubscriptionRef.set(status.snapshot, next)
	// Display snapshots contain values, so previously emitted trees never change.
	yield* TxSubscriptionRef.update(runtime.mounts, (mounts) =>
		HashMap.modify(mounts, id, (entry) => ({ ...entry, ...next })),
	)
}, Effect.tx)

/** Called inside the removal transaction, after supervisor cleanup. */
export const dispose = Effect.fnUntraced(function* (
	runtime: Runtime,
	id: number,
	status: MountStatus,
) {
	const current = yield* TxSubscriptionRef.get(status.snapshot)
	if (current.disposed) return
	const loading = yield* TxRef.get(status.loading)
	yield* adjustLoading(status.parent, -loading)
	yield* TxRef.set(status.loading, 0)
	yield* TxSubscriptionRef.set(status.snapshot, {
		...current,
		state: MountState.Unmounted(),
		disposed: true,
	})
	yield* TxSubscriptionRef.update(runtime.mounts, HashMap.remove(id))
})

/** Only the subtree's own counter belongs to this waiting transaction's read set. */
export const stable: (status: MountStatus) => Effect.Effect<void> =
	Effect.fnUntraced(function* (status: MountStatus) {
		if ((yield* TxRef.get(status.loading)) > 0) return yield* Effect.txRetry
	}, Effect.tx)
