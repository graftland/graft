import { Array as Arr, HashMap, HashSet, Option } from "effect"

import type { Event, State } from "../../src/internal/decisionCore.ts"
import { checked } from "./assertions.ts"

export interface Stimulus {
	readonly name: string
	readonly event: (state: State) => Event
}
export interface Exploration {
	readonly schedules: number
	readonly states: number
	readonly transitions: number
}
// Every causal shuffle is visited; the harness supplies only external reports.
export const explore = (
	initial: State,
	actors: ReadonlyArray<ReadonlyArray<Stimulus>>,
	terminal: (s: State) => void,
): Exploration => {
	const visit = (
		s: State,
		positions: HashMap.HashMap<number, number>,
		trace: ReadonlyArray<string>,
	): Exploration => {
		const enabled = Arr.filter(
			Arr.map(actors, (actor, id) => ({
				id,
				position: Option.getOrElse(HashMap.get(positions, id), () => 0),
				actor,
			})),
			({ position, actor }) => position < actor.length,
		)
		if (enabled.length === 0) {
			terminal(s)
			return { schedules: 1, states: 1, transitions: 0 }
		}
		return Arr.reduce(
			enabled,
			{ schedules: 0, states: 1, transitions: 0 },
			(stats, { id, position, actor }) =>
				Option.match(Arr.get(actor, position), {
					onNone: () => stats,
					onSome: (stimulus) => {
						const names = Arr.append(trace, stimulus.name)
						const next = checked(s, stimulus.event(s), names)
						const child = visit(
							next.state,
							HashMap.set(positions, id, position + 1),
							names,
						)
						return {
							schedules: stats.schedules + child.schedules,
							states: stats.states + child.states,
							transitions: stats.transitions + child.transitions + 1,
						}
					},
				}),
		)
	}
	return visit(initial, HashMap.empty(), [])
}
export interface Reachability {
	readonly states: HashSet.HashSet<State>
	readonly transitions: number
	readonly depth: number
}
// Breadth-first exploration deduplicates states, without adding a second reducer.
export const reachable = (
	initial: State,
	alphabet: ReadonlyArray<Stimulus>,
	depth: number,
): Reachability => {
	const visit = (
		frontier: HashMap.HashMap<State, ReadonlyArray<string>>,
		visited: HashSet.HashSet<State>,
		level: number,
		transitions: number,
	): Reachability => {
		if (level === depth || HashMap.size(frontier) === 0)
			return { states: visited, transitions, depth }
		const next = HashMap.reduce(
			frontier,
			HashMap.empty<State, ReadonlyArray<string>>(),
			(next, trace, state) =>
				Arr.reduce(alphabet, next, (next, stimulus) => {
					const names = Arr.append(trace, stimulus.name)
					const after = checked(state, stimulus.event(state), names).state
					return HashSet.has(visited, after)
						? next
						: HashMap.set(next, after, names)
				}),
		)
		return visit(
			next,
			HashSet.union(visited, HashSet.fromIterable(HashMap.keys(next))),
			level + 1,
			transitions + HashMap.size(frontier) * alphabet.length,
		)
	}
	return visit(
		HashMap.fromIterable<State, ReadonlyArray<string>>([[initial, []]]),
		HashSet.make(initial),
		0,
		0,
	)
}
