import { Array as Arr, Cause, HashMap, HashSet, Option } from "effect"

import {
	Action,
	cell,
	ObjectKey,
	type Generation,
	type Member,
	type Model,
	type Plan,
	type Token,
} from "./model.ts"

export const slot = (id: string, realm = "root"): ObjectKey =>
	ObjectKey.Slot({ realm, key: id })
export const instance = (id: string): ObjectKey => ObjectKey.Instance({ id })
export const group = (id: string): ObjectKey => ObjectKey.Group({ id })
export interface FixtureMember {
	readonly id: string
	readonly group?: string
	readonly realm?: string
	readonly dependencies?: ReadonlyArray<{
		readonly provider: string
		readonly optional: boolean
	}>
}
export const fixture = (
	members: ReadonlyArray<FixtureMember> = [
		{ id: "a" },
		{ id: "b" },
		{ id: "c" },
	],
): Model => {
	const empty: Model = {
		open: true,
		maxUnits: Number.POSITIVE_INFINITY,
		capacity: { used: members.length, reserved: 0 },
		unitOwners: HashMap.empty(),
		cells: HashMap.empty(),
		reservations: HashMap.empty(),
		changes: HashMap.empty(),
		generations: HashMap.empty(),
		terms: HashMap.empty(),
		groups: HashMap.empty(),
		leaseHolders: HashMap.empty(),
		unavailable: HashSet.empty(),
		stopping: HashSet.empty(),
		accesses: HashMap.empty(),
	}
	const base = Arr.reduce(members, empty, (s, m) => {
		const id = `${m.id}#0`
		const gen: Generation = {
			id,
			instance: m.id,
			config: "original",
			owner: "initial",
			publications: HashSet.make(slot(m.id, m.realm)),
			started: true,
			resolution: HashMap.empty(),
			leases: HashSet.empty(),
			evidence: "Missing",
			retired: false,
			cleanup: "Unknown",
			exitCause: Cause.empty,
		}
		const value = { version: 1, value: Option.some(id) }
		return {
			...s,
			cells: HashMap.set(
				HashMap.set(
					HashMap.set(s.cells, instance(m.id), value),
					slot(m.id, m.realm),
					value,
				),
				group(m.group ?? m.id),
				{ version: 1, value: Option.some(m.group ?? m.id) },
			),
			generations: HashMap.set(s.generations, id, gen),
			terms: HashMap.set(s.terms, m.id, 0),
			groups: HashMap.set(
				s.groups,
				m.group ?? m.id,
				HashSet.add(
					Option.getOrElse(HashMap.get(s.groups, m.group ?? m.id), () =>
						HashSet.empty(),
					),
					m.id,
				),
			),
		}
	})
	return Arr.reduce(members, base, (s, m) =>
		Arr.reduce(m.dependencies ?? [], s, (state, dep) => {
			const key = slot(dep.provider)
			const provider = cell(state, key).value
			if (Option.isNone(provider)) return state
			const id = `${m.id}#0`
			const gen = HashMap.getUnsafe(state.generations, id)
			return {
				...state,
				generations: HashMap.set(state.generations, id, {
					...gen,
					resolution: HashMap.set(gen.resolution, key, provider.value),
					leases: HashSet.add(gen.leases, provider.value),
				}),
				leaseHolders: HashMap.set(
					state.leaseHolders,
					provider.value,
					HashSet.add(
						Option.getOrElse(
							HashMap.get(state.leaseHolders, provider.value),
							() => HashSet.empty(),
						),
						id,
					),
				),
				cells: HashMap.set(
					state.cells,
					ObjectKey.Edge({ consumer: m.id, provider: dep.provider }),
					{ version: 1, value: provider },
				),
			}
		}),
	)
}

// Planning is outside the measured protocol. Fixtures supply complete footprints.
export const plan = (
	s: Model,
	id: string,
	specs: ReadonlyArray<FixtureMember>,
	strategy: Plan["strategy"] = "Overlap",
): Plan => {
	const members = Arr.reduce(specs, HashMap.empty<string, Member>(), (map, m) =>
		HashMap.set(map, m.id, {
			instance: m.id,
			old: Option.getOrThrow(cell(s, instance(m.id)).value),
			target: `${id} target`,
			startHealthy:
				!HashSet.has(s.unavailable, instance(m.id)) &&
				!HashMap.getUnsafe(
					s.generations,
					Option.getOrThrow(cell(s, instance(m.id)).value),
				).retired,
			group: m.group ?? m.id,
			publications: HashSet.make(slot(m.id, m.realm)),
			dependencies: Arr.reduce(
				m.dependencies ?? [],
				HashMap.empty<
					ObjectKey,
					{ readonly provider: string; readonly optional: boolean }
				>(),
				(deps, dep) => HashMap.set(deps, slot(dep.provider), dep),
			),
		}),
	)
	const writes = HashMap.reduce(
		members,
		HashSet.empty<ObjectKey>(),
		(keys, member) =>
			HashMap.reduce(
				member.dependencies,
				HashSet.union(
					HashSet.add(
						HashSet.add(keys, instance(member.instance)),
						group(member.group),
					),
					member.publications,
				),
				(acc, dep) =>
					HashSet.add(
						acc,
						ObjectKey.Edge({
							consumer: member.instance,
							provider: dep.provider,
						}),
					),
			),
	)
	const reads = HashMap.reduce(
		members,
		HashSet.reduce(
			writes,
			HashMap.empty<ObjectKey, ReturnType<typeof cell>>(),
			(map, key) => HashMap.set(map, key, cell(s, key)),
		),
		(map, member) =>
			HashMap.reduce(member.dependencies, map, (acc, _, key) =>
				HashMap.set(acc, key, cell(s, key)),
			),
	)
	return { id, members, reads, writes, strategy, participants: HashSet.empty() }
}
export const token = (
	change: string,
	member: string,
	term = 1,
	view = 1,
): Token => ({ change, generation: `${member}#${term}`, view })
export const activate = (
	id: string,
	member: string,
	term = 1,
	view = 1,
): ReadonlyArray<Action> => [
	Action.Install({ change: id }),
	Action.Acknowledge({ token: token(id, member, term, view) }),
	Action.Commit({ change: id }),
]
export const exit = (generation: string): ReadonlyArray<Action> => [
	Action.Evidence({ generation, evidence: "Exited" }),
	Action.Retire({ generation }),
]
export const accepting = (p: Plan, member: string): ReadonlyArray<Action> => [
	Action.Submit({ plan: p }),
	Action.Prepare({ change: p.id }),
	...activate(p.id, member),
	...exit(`${member}#0`),
	Action.Finish({ change: p.id }),
]
export interface Scenario {
	readonly name: string
	readonly initial: Model
	readonly actors: ReadonlyArray<ReadonlyArray<Action>>
}
export const independent = (): Scenario => {
	const initial = fixture()
	return {
		name: "independent changes",
		initial,
		actors: [
			accepting(plan(initial, "A", [{ id: "a" }]), "a"),
			accepting(plan(initial, "B", [{ id: "b" }]), "b"),
		],
	}
}
