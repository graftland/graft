import { Data, Effect, HashMap, HashSet, Option, TxRef } from "effect"

import type { ActiveResolution, GraphNode, Runtime } from "./runtime"

/** A token never transfers between activation cycles or managed attempts. */
export class Token extends Data.Class<{
	readonly fork: number
	readonly generation: number
}> {}

/** Called inside the transaction that resolves the generation's dependencies. */
export const acquire = Effect.fnUntraced(function* (
	runtime: Runtime,
	node: GraphNode,
	resolution: ActiveResolution,
) {
	const generation = yield* TxRef.get(runtime.generationIds)
	yield* TxRef.set(runtime.generationIds, generation + 1)
	const token = new Token({ fork: node.id, generation })
	for (const provision of resolution.provisions)
		yield* TxRef.update(provision.consumers, HashSet.add(token))
	yield* TxRef.update(node.state, (state) => ({
		...state,
		resolutions: HashMap.set(state.resolutions, token, resolution),
	}))
	return token
})

/** Exit evidence releases runtime leases; it does not certify host finalizers. */
export const settle = Effect.fnUntraced(function* (
	node: GraphNode,
	token: Token,
) {
	const state = yield* TxRef.get(node.state)
	const resolution = HashMap.get(state.resolutions, token)
	if (Option.isNone(resolution)) return
	for (const provision of resolution.value.provisions)
		yield* TxRef.update(provision.consumers, HashSet.remove(token))
	yield* TxRef.set(node.state, {
		...state,
		resolutions: HashMap.remove(state.resolutions, token),
	})
})
