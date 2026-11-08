/** Current availability and exact generation evidence are projections of core data. */
import { Array, Cause, HashMap, HashSet, Option } from "effect"

import type { MemberExecution, State, Unit, UnitMember } from "./decisionState"

export const key = (
	member: Pick<UnitMember, "instance" | "term" | "generation">,
): string =>
	`${member.instance.length}:${member.instance}/${member.term}/${member.generation}`
export const evidence = (
	grant: UnitMember,
	phase: MemberExecution["phase"],
): MemberExecution => ({
	...grant,
	endpoint: Option.none(),
	phase,
	cause: Cause.empty,
	cleanup: { _tag: "Unknown" },
})
export const members = (
	grants: HashMap.HashMap<string, UnitMember>,
	phase: MemberExecution["phase"],
): HashMap.HashMap<string, MemberExecution> =>
	HashMap.map(grants, (grant) => evidence(grant, phase))
export const current = (
	state: State,
	id: string,
): Option.Option<{ readonly unit: Unit; readonly member: MemberExecution }> =>
	Option.flatMap(
		Option.flatMap(
			HashMap.get(state.instances, id),
			(instance) => instance.current,
		),
		(unit) =>
			Option.flatMap(HashMap.get(state.units, unit), (unit) =>
				Option.map(HashMap.get(unit.members, id), (member) => ({
					unit,
					member,
				})),
			),
	)
export const authorized = (
	state: State,
	id: string,
	target: UnitMember["target"],
): boolean =>
	Option.match(
		Option.flatMap(HashMap.get(state.policies, id), (policy) => policy.allowed),
		{
			onNone: () => true,
			onSome: (allowed) => HashSet.has(allowed, target.identity),
		},
	)
export const healthy = (state: State, id: string): boolean =>
	Option.exists(
		current(state, id),
		({ unit, member }) =>
			unit.evidence === "Missing" &&
			unit.phase === "Running" &&
			member.phase === "Ready" &&
			authorized(state, id, member.target),
	)
export const grants = (
	members: Unit["members"],
): HashMap.HashMap<string, UnitMember> =>
	HashMap.map(members, (member) => ({
		instance: member.instance,
		target: member.target,
		term: member.term,
		generation: member.generation,
		declaration: member.declaration,
		parent: member.parent,
		realm: member.realm,
		placement: member.placement,
		colocate: member.colocate,
		dependencies: member.dependencies,
	}))
export const tokens = (members: HashMap.HashMap<string, UnitMember>) =>
	HashMap.map(members, (member) => ({
		term: member.term,
		generation: member.generation,
	}))
const add = (
	index: HashMap.HashMap<string, HashSet.HashSet<string>>,
	key: string,
	member: string,
) =>
	HashMap.set(
		index,
		key,
		HashSet.add(
			Option.getOrElse(HashMap.get(index, key), HashSet.empty<string>),
			member,
		),
	)
export const indexes = (members: Unit["members"]) =>
	HashMap.reduce(
		members,
		{
			localConsumers: HashMap.empty<string, HashSet.HashSet<string>>(),
			children: HashMap.empty<string, HashSet.HashSet<string>>(),
		},
		(out, member) => ({
			localConsumers: Array.reduce(
				member.dependencies,
				out.localConsumers,
				(index, dependency) =>
					dependency.kind === "Local"
						? Option.match(dependency.provider, {
								onNone: () => index,
								onSome: (provider) => add(index, provider, member.instance),
							})
						: index,
			),
			children: Option.match(member.parent, {
				onNone: () => out.children,
				onSome: (parent) => add(out.children, parent, member.instance),
			}),
		}),
	)
export const update = (
	unit: Unit,
	subjects: HashSet.HashSet<string>,
	phase: MemberExecution["phase"],
): Unit => ({
	...unit,
	members: HashSet.reduce(subjects, unit.members, (index, id) =>
		HashMap.modify(index, id, (member) =>
			member.phase === "Stopped" ||
			member.phase === "NotStarted" ||
			member.phase === "Failed"
				? member
				: { ...member, phase },
		),
	),
})
export const affect = (unit: Unit, member: string): HashSet.HashSet<string> => {
	const expand = (
		selected: HashSet.HashSet<string>,
	): HashSet.HashSet<string> => {
		const next = HashSet.reduce(selected, selected, (out, id) =>
			HashSet.union(
				out,
				HashSet.union(
					Option.getOrElse(
						HashMap.get(unit.localConsumers, id),
						HashSet.empty<string>,
					),
					Option.getOrElse(
						HashMap.get(unit.children, id),
						HashSet.empty<string>,
					),
				),
			),
		)
		return HashSet.size(next) === HashSet.size(selected) ? next : expand(next)
	}
	return expand(HashSet.make(member))
}
/** Scope ownership and captured dependency edges order each granted activation. */
export const waves = (
	unit: Unit,
	selected: HashSet.HashSet<string>,
): ReadonlyArray<HashSet.HashSet<string>> => {
	const order = (
		remaining: HashSet.HashSet<string>,
		out: ReadonlyArray<HashSet.HashSet<string>>,
	): ReadonlyArray<HashSet.HashSet<string>> => {
		if (HashSet.size(remaining) === 0) return out
		const ready = HashSet.filter(remaining, (id) =>
			Option.exists(
				HashMap.get(unit.members, id),
				(member) =>
					!Option.exists(member.parent, (parent) =>
						HashSet.has(remaining, parent),
					) &&
					!Array.some(member.dependencies, (dependency) =>
						Option.exists(dependency.provider, (provider) =>
							HashSet.has(remaining, provider),
						),
					),
			),
		)
		return HashSet.size(ready) === 0
			? []
			: order(HashSet.difference(remaining, ready), Array.append(out, ready))
	}
	return order(selected, [])
}
