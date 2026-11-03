import {
	Array,
	Effect,
	HashMap,
	HashSet,
	Option,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import type {
	ActiveResolution,
	ForkEntry,
	Provision,
	Runtime,
	ServiceKey,
} from "./runtime"

/** The exact dependency snapshot must still be valid when plugin code publishes. */
export const resolutionChanged = (
	resolution: ActiveResolution,
	registry: HashMap.HashMap<ServiceKey, Provision>,
): boolean =>
	Array.some(
		resolution.provisions,
		(provision) =>
			!Option.exists(
				HashMap.get(registry, provision.key),
				(current) => current === provision,
			),
	) || HashSet.some(resolution.watch, (key) => HashMap.has(registry, key))

/** A fixed point over one immutable snapshot; no fiber can interleave with this calculation. */
const affectedForks = (
	forks: HashMap.HashMap<number, ForkEntry>,
	active: HashMap.HashMap<number, ActiveResolution>,
	key: ServiceKey,
): HashSet.HashSet<number> => {
	let affected = HashSet.fromIterable(
		Array.flatMap(HashMap.toEntries(active), ([id, resolution]) =>
			HashSet.has(resolution.watch, key) ? [id] : [],
		),
	)
	while (true) {
		const next = Array.reduce(
			HashMap.toValues(forks),
			affected,
			(result, fork) => {
				const inherited =
					fork.parent !== undefined && HashSet.has(result, fork.parent)
				const consumes = HashMap.get(active, fork.id).pipe(
					Option.exists((resolution) =>
						Array.some(resolution.provisions, (provision) =>
							HashSet.has(result, provision.owner),
						),
					),
				)
				return inherited || consumes ? HashSet.add(result, fork.id) : result
			},
		)
		if (HashSet.size(next) === HashSet.size(affected)) return next
		affected = next
	}
}

/** Call inside the publication transaction, or a transaction waiting to retry it. */
export const publicationCycle = Effect.fnUntraced(function* (
	runtime: Runtime,
	publisher: number,
	key: ServiceKey,
	candidate?: ActiveResolution,
) {
	const forks = yield* TxSubscriptionRef.get(runtime.forks)
	const current = yield* TxRef.get(runtime.active)
	const active =
		candidate === undefined
			? current
			: HashMap.set(current, publisher, candidate)
	const affected = affectedForks(forks, active, key)
	return HashSet.has(affected, publisher)
})
