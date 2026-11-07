import { Array as Arr, HashMap, HashSet, Option, Result } from "effect"

import { step, type Action, type Model, type Step } from "./model.ts"
import type { Scenario } from "./scenarios.ts"

export interface Observer {
	readonly transition: (
		before: Model,
		action: Action,
		after: Step,
		trace: ReadonlyArray<Action>,
	) => void
	readonly terminal: (state: Model, trace: ReadonlyArray<Action>) => void
}
export interface Exploration {
	readonly schedules: number
	readonly transitions: number
}
// Enumerate every shuffle preserving each actor's causal order. Rejections consume
// a command; retries must be explicit. There is no partial-order reduction.
export const explore = (
	scenario: Scenario,
	observer: Observer,
): Exploration => {
	const visit = (
		state: Model,
		positions: HashMap.HashMap<number, number>,
		trace: ReadonlyArray<Action>,
	): Exploration => {
		const enabled = Arr.filterMap(scenario.actors, (actions, actor) => {
			const position = HashMap.getUnsafe(positions, actor)
			return Result.fromOption(
				Option.map(Arr.get(actions, position), (action) => ({
					action,
					actor,
					position,
				})),
				() => "Exhausted",
			)
		})
		if (enabled.length === 0) {
			observer.terminal(state, trace)
			return { schedules: 1, transitions: 0 }
		}
		return Arr.reduce(
			enabled,
			{ schedules: 0, transitions: 0 },
			(total, { action, actor, position }) => {
				const after = step(state, action)
				const nextTrace = Arr.append(trace, action)
				observer.transition(state, action, after, nextTrace)
				const child = visit(
					after.state,
					HashMap.set(positions, actor, position + 1),
					nextTrace,
				)
				return {
					schedules: total.schedules + child.schedules,
					transitions: total.transitions + child.transitions + 1,
				}
			},
		)
	}
	return visit(
		scenario.initial,
		HashMap.fromIterable(
			Arr.map(scenario.actors, (_, index): readonly [number, number] => [
				index,
				0,
			]),
		),
		[],
	)
}

// Explore arbitrary repetitions of an action alphabet to a depth. Structural
// state deduplication is sound here: commands depend only on the current state.
export const reachable = (
	initial: Model,
	alphabet: ReadonlyArray<Action>,
	depth: number,
	check: Observer["transition"],
): HashSet.HashSet<Model> => {
	let frontier = HashSet.make(initial)
	let visited = frontier
	for (let level = 0; level < depth; level++) {
		const next = HashSet.reduce(
			frontier,
			HashSet.empty<Model>(),
			(states, before) =>
				Arr.reduce(alphabet, states, (acc, action) => {
					const after = step({ ...before, accesses: HashMap.empty() }, action)
					check(before, action, after, [action])
					const state = { ...after.state, accesses: HashMap.empty() }
					return HashSet.has(visited, state) ? acc : HashSet.add(acc, state)
				}),
		)
		visited = HashSet.union(visited, next)
		frontier = next
	}
	return visited
}
