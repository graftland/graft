import { Array, Effect, HashMap, HashSet, Option, TxRef } from "effect"

import type { Plugin } from "../Plugin"

type GroupState =
	| { readonly _tag: "Root"; readonly target: Plugin; readonly rank: number }
	| { readonly _tag: "Link"; readonly group: Group }

interface Group {
	readonly state: TxRef.TxRef<GroupState>
}

type Cell = TxRef.TxRef<Group>

/** Weak identities retain only their current family, never a list of historical plugins. */
export interface Aliases {
	readonly identities: WeakMap<Plugin, Cell>
}

/** Weak keys are necessary: an obsolete plugin must not be retained by the alias registry. */
export const make = (): Aliases => ({ identities: new WeakMap() })

const makeGroup = (target: Plugin): Group => ({
	state: TxRef.makeUnsafe<GroupState>({ _tag: "Root", target, rank: 0 }),
})

const identity = (aliases: Aliases, plugin: Plugin): Cell => {
	const existing = aliases.identities.get(plugin)
	if (existing !== undefined) return existing
	// Installing an identity is harmless on rollback: its initial meaning is always itself.
	const cell = TxRef.makeUnsafe(makeGroup(plugin))
	aliases.identities.set(plugin, cell)
	return cell
}

export const resolve = Effect.fnUntraced(function* (
	aliases: Aliases,
	plugin: Plugin,
) {
	let group = yield* TxRef.get(identity(aliases, plugin))
	while (true) {
		const state = yield* TxRef.get(group.state)
		if (state._tag === "Root") return state.target
		group = state.group
	}
})

/**
 * Stages a flat-alias transition before touching transaction state. A caller may
 * catch a conflict inside an outer transaction without accidentally committing
 * the rejected aliases. Successful writes share the caller's transaction.
 */
export const replace = Effect.fnUntraced(function* (
	aliases: Aliases,
	pairs: ReadonlyArray<readonly [from: Plugin, to: Plugin]>,
) {
	let cells = HashMap.empty<Cell, Group>()
	let groups = HashMap.empty<Group, GroupState>()
	// Which pairs staged each write, so that a rollback can undo pairs separately.
	let cellPairs = HashMap.empty<Cell, HashSet.HashSet<number>>()
	let groupPairs = HashMap.empty<Group, HashSet.HashSet<number>>()
	const touch = <K>(
		owners: HashMap.HashMap<K, HashSet.HashSet<number>>,
		key: K,
		index: number,
	) =>
		HashMap.set(
			owners,
			key,
			HashSet.add(
				Option.getOrElse(HashMap.get(owners, key), HashSet.empty<number>),
				index,
			),
		)
	const readCell = (cell: Cell) =>
		Option.match(HashMap.get(cells, cell), {
			onNone: () => TxRef.get(cell),
			onSome: Effect.succeed,
		})
	const readGroup = (group: Group) =>
		Option.match(HashMap.get(groups, group), {
			onNone: () => TxRef.get(group.state),
			onSome: Effect.succeed,
		})
	const root = Effect.fnUntraced(function* (cell: Cell) {
		let group = yield* readCell(cell)
		while (true) {
			const state = yield* readGroup(group)
			if (state._tag === "Root") return { group, state }
			group = state.group
		}
	})
	const current = yield* Effect.forEach(pairs, ([from]) =>
		resolve(aliases, from),
	)
	for (const [index, [from, to]] of pairs.entries()) {
		const targetCell = identity(aliases, to)
		let target = yield* root(targetCell)
		// An old version can become a target again without redirecting its former family.
		if (target.state.target !== to) {
			const group = makeGroup(to)
			cells = HashMap.set(cells, targetCell, group)
			cellPairs = touch(cellPairs, targetCell, index)
			target = yield* root(targetCell)
		}
		if (from === to) continue
		const sourceCell = identity(aliases, from)
		const source = yield* root(sourceCell)
		if (source.state.target !== from) {
			// A stale source changes only its own identity, just like the flat alias map.
			cells = HashMap.set(cells, sourceCell, target.group)
			cellPairs = touch(cellPairs, sourceCell, index)
		} else if (source.group !== target.group) {
			const winner = source.state.rank > target.state.rank ? source : target
			const loser = winner === source ? target : source
			groups = HashMap.set(groups, loser.group, {
				_tag: "Link",
				group: winner.group,
			})
			groups = HashMap.set(groups, winner.group, {
				_tag: "Root",
				target: to,
				rank:
					winner.state.rank + (source.state.rank === target.state.rank ? 1 : 0),
			})
			groupPairs = touch(
				touch(groupPairs, loser.group, index),
				winner.group,
				index,
			)
		}
	}
	const checks = yield* Effect.forEach(pairs, ([from, to], index) =>
		Effect.gen(function* () {
			const overlap =
				from !== to &&
				Array.some(
					pairs,
					([other, target]) =>
						other !== target && (to === other || from === target),
				)
			const source = yield* root(identity(aliases, from))
			const previous = yield* root(identity(aliases, current[index]!))
			const target = yield* root(identity(aliases, to))
			return overlap ||
				source.state.target !== to ||
				previous.state.target !== to ||
				target.state.target !== to
				? Option.some(index)
				: Option.none()
		}),
	)
	const conflicts = Array.getSomes(checks)
	if (conflicts.length > 0) return { conflicts, undo: [] }
	const pairsOf = <K>(
		owners: HashMap.HashMap<K, HashSet.HashSet<number>>,
		key: K,
	) => Option.getOrElse(HashMap.get(owners, key), HashSet.empty<number>)
	const cellWrites = yield* Effect.forEach(cells, ([cell, group]) =>
		TxRef.modify(cell, (previous) => [
			write(cell, group, previous, pairsOf(cellPairs, cell)),
			group,
		]),
	)
	const groupWrites = yield* Effect.forEach(groups, ([group, state]) =>
		TxRef.modify(group.state, (previous) => [
			write(group.state, state, previous, pairsOf(groupPairs, group)),
			state,
		]),
	)
	return { conflicts, undo: [...cellWrites, ...groupWrites] }
})

/** One alias write, with the value it replaced and the pairs that made it. */
export interface Write {
	readonly pairs: HashSet.HashSet<number>
	/** Whether the reference still holds what this write put there. */
	readonly unchanged: Effect.Effect<boolean>
	readonly revert: Effect.Effect<void>
}

const write = <A>(
	ref: TxRef.TxRef<A>,
	written: A,
	previous: A,
	pairs: HashSet.HashSet<number>,
): Write => ({
	pairs,
	unchanged: Effect.map(TxRef.get(ref), (current) => current === written),
	revert: TxRef.set(ref, previous),
})

/**
 * Undoes a replacement's alias writes. Pairs whose writes a later replacement
 * has changed, and pairs that share writes with them, keep the later aliases;
 * every other pair goes back. Run it in a transaction.
 */
export const restore = Effect.fnUntraced(function* (
	undo: ReadonlyArray<Write>,
) {
	const unchanged = yield* Effect.forEach(undo, (entry) => entry.unchanged)
	let kept = Array.reduce(
		undo,
		HashSet.empty<number>(),
		(kept, entry, index) =>
			unchanged[index] === true ? kept : HashSet.union(kept, entry.pairs),
	)
	// Pairs that share a write are undone together or not at all.
	while (true) {
		const grown = Array.reduce(undo, kept, (kept, entry) =>
			Array.some(Array.fromIterable(entry.pairs), (pair) =>
				HashSet.has(kept, pair),
			)
				? HashSet.union(kept, entry.pairs)
				: kept,
		)
		if (HashSet.size(grown) === HashSet.size(kept)) break
		kept = grown
	}
	yield* Effect.forEach(
		Array.reverse(
			Array.filter(undo, (entry) =>
				Array.every(
					Array.fromIterable(entry.pairs),
					(pair) => !HashSet.has(kept, pair),
				),
			),
		),
		(entry) => entry.revert,
		{ discard: true },
	)
})
