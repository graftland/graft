import { Effect, HashMap, HashSet, Option, TxRef } from "effect"
import type { ActiveResolution, GraphNode, ServiceKey } from "./runtime"

/** The exact dependency snapshot must still be valid when plugin code publishes. */
export const resolutionChanged = Effect.fnUntraced(function* (
	resolution: ActiveResolution,
) {
	for (const provision of resolution.provisions) {
		const current = yield* TxRef.get(provision.slot.provision)
		if (!Option.exists(current, (current) => current === provision)) return true
	}
	for (const slot of HashMap.values(resolution.watch)) {
		const current = yield* TxRef.get(slot.provision)
		if (Option.isSome(current)) return true
	}
	return false
})

interface WorkList {
	readonly node: GraphNode
	readonly next: WorkList | undefined
}

/** Reverse reachability reads only nodes that can affect this publisher. Call within a transaction. */
export const publicationCycle = Effect.fnUntraced(function* (
	publisher: GraphNode,
	key: ServiceKey,
	candidate?: ActiveResolution,
) {
	let pending: WorkList | undefined = { node: publisher, next: undefined }
	let seen = HashSet.empty<number>()
	while (pending !== undefined) {
		const node = pending.node
		pending = pending.next
		if (HashSet.has(seen, node.id)) continue
		seen = HashSet.add(seen, node.id)
		const state = yield* TxRef.get(node.state)
		if (!state.live) continue
		const resolution =
			node === publisher && candidate !== undefined
				? candidate
				: state.resolution
		if (resolution !== undefined) {
			if (HashMap.has(resolution.watch, key)) return true
			for (const provision of resolution.provisions) {
				pending = { node: provision.node, next: pending }
			}
		}
		if (node.parent !== undefined)
			pending = { node: node.parent, next: pending }
	}
	return false
})
