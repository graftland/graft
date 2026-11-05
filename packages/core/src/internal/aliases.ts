import { Array, Effect, HashMap, Option, TxRef } from "effect"

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
	for (const [from, to] of pairs) {
		const targetCell = identity(aliases, to)
		let target = yield* root(targetCell)
		// An old version can become a target again without redirecting its former family.
		if (target.state.target !== to) {
			const group = makeGroup(to)
			cells = HashMap.set(cells, targetCell, group)
			target = yield* root(targetCell)
		}
		if (from === to) continue
		const sourceCell = identity(aliases, from)
		const source = yield* root(sourceCell)
		if (source.state.target !== from) {
			// A stale source changes only its own identity, just like the flat alias map.
			cells = HashMap.set(cells, sourceCell, target.group)
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
	if (conflicts.length > 0) return conflicts
	for (const [cell, group] of cells) yield* TxRef.set(cell, group)
	for (const [group, state] of groups) yield* TxRef.set(group.state, state)
	return conflicts
})
