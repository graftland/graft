/** Indexed deployment declarations and old/new closure. No runtime handles enter this module. */
import {
	Array,
	Cause,
	Data,
	Equal,
	HashMap,
	HashSet,
	Number as Num,
	Option,
	Result,
	String,
} from "effect"

import * as Bindings from "./bindingCore"
import * as Snapshot from "./decisionInput"
import type {
	BindingDeclaration,
	DeploymentGroup,
	GraphProposal,
	GraphTopology,
	GroupPlan,
	MemberDeclaration,
	PlacementRequirement,
	RealmDeclaration,
	Rejection,
	ResolvedDependency,
	SelectionReason,
	State,
	Strategy,
} from "./decisionState"
import * as Executions from "./executionState"

export interface Fault {
	readonly reason: Rejection
	readonly conflicts: HashSet.HashSet<string>
	readonly cause: Cause.Cause<unknown>
}
const fault = (
	reason: Rejection,
	keys: Iterable<string>,
	detail: string,
): Fault => ({
	reason,
	conflicts: HashSet.fromIterable(keys),
	cause: Cause.fail(detail),
})
const setAt = (
	index: HashMap.HashMap<string, HashSet.HashSet<string>>,
	key: string,
): HashSet.HashSet<string> =>
	Option.getOrElse(HashMap.get(index, key), HashSet.empty<string>)
const add = (
	index: HashMap.HashMap<string, HashSet.HashSet<string>>,
	key: string,
	value: string,
) => HashMap.set(index, key, HashSet.add(setAt(index, key), value))
const remove = (
	index: HashMap.HashMap<string, HashSet.HashSet<string>>,
	key: string,
	value: string,
) =>
	HashMap.modifyAt(
		index,
		key,
		Option.flatMap((values) => {
			const next = HashSet.remove(values, value)
			return HashSet.size(next) === 0 ? Option.none() : Option.some(next)
		}),
	)
export const slot = (
	realm: string,
	kind: "Local" | "Contract",
	key: string,
): string => `slot:${kind}:${realm.length}:${realm}:${key}`
export const membership = (group: string): string => `membership:${group}`
export const memberSlot = (instance: string): string =>
	`membership-of:${instance}`
export const resource = (key: string): string => `resource:${key}`
export const empty = (): GraphTopology => ({
	declarations: HashMap.empty(),
	realms: HashMap.empty(),
	providers: HashMap.empty(),
	slotConsumers: HashMap.empty(),
	dependencies: HashMap.empty(),
	localConsumers: HashMap.empty(),
	contractConsumers: HashMap.empty(),
	children: HashMap.empty(),
	colocations: HashMap.empty(),
	membersByRealm: HashMap.empty(),
	childRealms: HashMap.empty(),
	resourceOwners: HashMap.empty(),
	groups: HashMap.empty(),
	memberships: HashMap.empty(),
	nextGroup: 1,
})

const realm = (g: GraphTopology, r: RealmDeclaration): GraphTopology => {
	const previous = HashMap.get(g.realms, r.id)
	const removed = Option.flatMap(previous, (r) => r.parent)
	const children = Option.match(removed, {
		onNone: () => g.childRealms,
		onSome: (parent) => remove(g.childRealms, parent, r.id),
	})
	return {
		...g,
		realms: HashMap.set(g.realms, r.id, Object.freeze({ ...r })),
		childRealms: Option.match(r.parent, {
			onNone: () => children,
			onSome: (parent) => add(children, parent, r.id),
		}),
	}
}
const provided = (m: MemberDeclaration): ReadonlyArray<string> => [
	...Array.map(m.localProvides, (key) => slot(m.realm, "Local", key)),
	...Array.map(m.provides, (d) => slot(m.realm, "Contract", d.key)),
]
const indexMember = (
	g: GraphTopology,
	m: MemberDeclaration,
	adding: boolean,
): GraphTopology => {
	const update = adding ? add : remove
	return {
		...g,
		providers: Array.reduce(provided(m), g.providers, (out, key) =>
			update(out, key, m.instance),
		),
		children: Option.match(m.parent, {
			onNone: () => g.children,
			onSome: (parent) => update(g.children, parent, m.instance),
		}),
		colocations: Array.reduce(m.colocate, g.colocations, (out, key) =>
			update(out, key, m.instance),
		),
		membersByRealm: update(g.membersByRealm, m.realm, m.instance),
		resourceOwners: Array.reduce(m.resources, g.resourceOwners, (out, r) =>
			update(out, r.key, m.instance),
		),
	}
}
const removeDependencies = (g: GraphTopology, id: string): GraphTopology =>
	Array.reduce(
		Option.getOrElse(HashMap.get(g.dependencies, id), () => []),
		g,
		(out, d) => ({
			...out,
			slotConsumers: HashSet.reduce(d.slots, out.slotConsumers, (index, key) =>
				remove(index, key, id),
			),
			localConsumers:
				d.kind === "Local"
					? Option.match(d.provider, {
							onNone: () => out.localConsumers,
							onSome: (p) => remove(out.localConsumers, p, id),
						})
					: out.localConsumers,
			contractConsumers:
				d.kind === "Contract"
					? Option.match(d.provider, {
							onNone: () => out.contractConsumers,
							onSome: (p) => remove(out.contractConsumers, p, id),
						})
					: out.contractConsumers,
		}),
	)
const erase = (g: GraphTopology, id: string): GraphTopology =>
	Option.match(HashMap.get(g.declarations, id), {
		onNone: () => g,
		onSome: (m) => {
			const out = indexMember(removeDependencies(g, id), m, false)
			return {
				...out,
				declarations: HashMap.remove(out.declarations, id),
				dependencies: HashMap.remove(out.dependencies, id),
			}
		},
	})
const insert = (g: GraphTopology, m: MemberDeclaration): GraphTopology => {
	const out = erase(g, m.instance)
	const value = Snapshot.declaration(m)
	return indexMember(
		{
			...out,
			declarations: HashMap.set(out.declarations, value.instance, value),
		},
		value,
		true,
	)
}
interface Lookup {
	readonly provider: Option.Option<string>
	readonly slots: HashSet.HashSet<string>
	readonly ambiguous: boolean
}
const lookup = (
	g: GraphTopology,
	id: string,
	kind: "Local" | "Contract",
	key: string,
	seen: HashSet.HashSet<string> = HashSet.empty(),
	slots: HashSet.HashSet<string> = HashSet.empty(),
): Lookup => {
	const cell = slot(id, kind, key)
	const visited = HashSet.add(HashSet.add(slots, `realm:${id}`), cell)
	const providers = setAt(g.providers, cell)
	if (HashSet.size(providers) > 0)
		return {
			provider:
				HashSet.size(providers) === 1
					? Array.head(Array.fromIterable(providers))
					: Option.none(),
			slots: visited,
			ambiguous: HashSet.size(providers) > 1,
		}
	const current = HashMap.get(g.realms, id)
	if (
		HashSet.has(seen, id) ||
		Option.isNone(current) ||
		HashSet.has(current.value.isolated, key) ||
		Option.isNone(current.value.parent)
	)
		return { provider: Option.none(), slots: visited, ambiguous: false }
	return lookup(
		g,
		current.value.parent.value,
		kind,
		key,
		HashSet.add(seen, id),
		visited,
	)
}
const requirement = (
	g: GraphTopology,
	m: MemberDeclaration,
	kind: "Local" | "Contract",
	key: string,
	optional: boolean,
	contract?: BindingDeclaration,
): ResolvedDependency => {
	const found = lookup(g, m.realm, kind, key)
	const provider = Option.filter(
		found.provider,
		(id) =>
			kind === "Local" ||
			Option.exists(HashMap.get(g.declarations, id), (p) =>
				Array.some(
					p.provides,
					(d) =>
						d.key === key &&
						contract !== undefined &&
						Option.isNone(Bindings.validate(contract, d)),
				),
			),
	)
	return {
		kind,
		service: key,
		provider,
		optional,
		slots: found.slots,
		ambiguous: found.ambiguous,
	}
}
const resolveMember = (g: GraphTopology, id: string): GraphTopology =>
	Option.match(HashMap.get(g.declarations, id), {
		onNone: () => g,
		onSome: (m) => {
			const base = removeDependencies(g, id)
			const dependencies = [
				...Array.map(m.localRequires, (r) =>
					requirement(base, m, "Local", r.key, r.optional),
				),
				...Array.map(m.requires, (r) =>
					requirement(base, m, "Contract", r.key, r.optional, r),
				),
			]
			return Array.reduce(
				dependencies,
				{
					...base,
					dependencies: HashMap.set(base.dependencies, id, dependencies),
				},
				(out, d) => ({
					...out,
					slotConsumers: HashSet.reduce(
						d.slots,
						out.slotConsumers,
						(index, key) => add(index, key, id),
					),
					localConsumers:
						d.kind === "Local"
							? Option.match(d.provider, {
									onNone: () => out.localConsumers,
									onSome: (p) => add(out.localConsumers, p, id),
								})
							: out.localConsumers,
					contractConsumers:
						d.kind === "Contract"
							? Option.match(d.provider, {
									onNone: () => out.contractConsumers,
									onSome: (p) => add(out.contractConsumers, p, id),
								})
							: out.contractConsumers,
				}),
			)
		},
	})
const dependencies = (
	g: GraphTopology,
	id: string,
): ReadonlyArray<ResolvedDependency> =>
	Option.getOrElse(HashMap.get(g.dependencies, id), () => [])
const localProviders = (
	g: GraphTopology,
	id: string,
): HashSet.HashSet<string> =>
	HashSet.fromIterable(
		Array.flatMap(dependencies(g, id), (d) =>
			d.kind === "Local" ? Option.toArray(d.provider) : [],
		),
	)
const neighbors = (g: GraphTopology, id: string): HashSet.HashSet<string> =>
	Option.match(HashMap.get(g.declarations, id), {
		onNone: () => HashSet.empty<string>(),
		onSome: (m) =>
			HashSet.union(
				HashSet.union(
					HashSet.union(localProviders(g, id), setAt(g.localConsumers, id)),
					HashSet.union(
						setAt(g.children, id),
						HashSet.fromIterable(Option.toArray(m.parent)),
					),
				),
				Array.reduce(m.colocate, HashSet.empty<string>(), (ids, key) =>
					HashSet.union(ids, setAt(g.colocations, key)),
				),
			),
	})
const expand = (
	seed: HashSet.HashSet<string>,
	related: (id: string) => HashSet.HashSet<string>,
): HashSet.HashSet<string> => {
	const next = HashSet.reduce(seed, seed, (all, id) =>
		HashSet.union(all, related(id)),
	)
	return HashSet.size(next) === HashSet.size(seed)
		? next
		: expand(next, related)
}
const oldMembers = (g: GraphTopology, id: string): HashSet.HashSet<string> =>
	Option.match(
		Option.flatMap(HashMap.get(g.memberships, id), (group) =>
			HashMap.get(g.groups, group),
		),
		{ onNone: () => HashSet.empty<string>(), onSome: (group) => group.members },
	)
const componentPlacement = (
	g: GraphTopology,
	ids: HashSet.HashSet<string>,
): Result.Result<PlacementRequirement, Fault> => {
	const requirements = Array.flatMap(Array.fromIterable(ids), (id) =>
		Option.toArray(
			Option.flatMap(HashMap.get(g.declarations, id), (m) => m.placement),
		),
	)
	const first = Array.head(requirements)
	if (Option.isNone(first)) return Result.succeed({ kind: "Worker" })
	return Array.every(requirements, (r) => Equal.equals(r, first.value))
		? Result.succeed(first.value)
		: Result.fail(
				fault(
					"PlacementConflict",
					ids,
					"Co-located members require different placements, destinations or security profiles",
				),
			)
}
const rebuildGroups = (
	before: GraphTopology,
	after: GraphTopology,
	region: HashSet.HashSet<string>,
): Result.Result<GraphTopology, Fault> => {
	const cleared = HashSet.reduce(region, after, (g, id) => ({
		...g,
		groups: Option.match(HashMap.get(g.memberships, id), {
			onNone: () => g.groups,
			onSome: (old) => HashMap.remove(g.groups, old),
		}),
		memberships: HashMap.remove(g.memberships, id),
	}))
	return HashSet.reduce(
		region,
		Result.succeed(cleared),
		(result, id): Result.Result<GraphTopology, Fault> =>
			Result.flatMap(result, (g) => {
				if (!HashMap.has(g.declarations, id) || HashMap.has(g.memberships, id))
					return Result.succeed(g)
				const members = expand(HashSet.make(id), (member) =>
					neighbors(g, member),
				)
				return Result.map(componentPlacement(g, members), (placement) => {
					const prior = Option.flatMap(
						HashMap.get(before.memberships, id),
						(key) => HashMap.get(before.groups, key),
					)
					const reuse = Option.filter(
						prior,
						(old) =>
							Equal.equals(old.members, members) &&
							Equal.equals(old.placement, placement),
					)
					const group = Option.getOrElse(reuse, () => ({
						id: `group-${g.nextGroup}`,
						version: g.nextGroup,
						members,
						placement,
					}))
					return {
						...g,
						groups: HashMap.set(g.groups, group.id, group),
						memberships: HashSet.reduce(
							members,
							g.memberships,
							(index, member) => HashMap.set(index, member, group.id),
						),
						nextGroup: Option.isSome(reuse) ? g.nextGroup : g.nextGroup + 1,
					}
				})
			}),
	)
}
const touchedRealms = (
	g: GraphTopology,
	realms: ReadonlyArray<RealmDeclaration>,
): HashSet.HashSet<string> =>
	expand(HashSet.fromIterable(Array.map(realms, (r) => r.id)), (id) =>
		setAt(g.childRealms, id),
	)
const edit = (
	before: GraphTopology,
	proposal: GraphProposal,
): GraphTopology => {
	const touched = HashSet.union(
		proposal.removed,
		HashSet.fromIterable(Array.map(proposal.members, (m) => m.instance)),
	)
	const slots = HashSet.reduce(touched, HashSet.empty<string>(), (all, id) =>
		HashSet.union(
			all,
			HashSet.fromIterable(
				Option.match(HashMap.get(before.declarations, id), {
					onNone: () => [],
					onSome: provided,
				}),
			),
		),
	)
	const removed = HashSet.reduce(proposal.removed, before, erase)
	const inserted = Array.reduce(
		proposal.members,
		Array.reduce(proposal.realms, removed, realm),
		insert,
	)
	const newSlots = HashSet.union(
		slots,
		HashSet.fromIterable(Array.flatMap(proposal.members, provided)),
	)
	const realmMembers = HashSet.reduce(
		HashSet.union(
			touchedRealms(before, proposal.realms),
			touchedRealms(inserted, proposal.realms),
		),
		HashSet.empty<string>(),
		(ids, r) =>
			HashSet.union(
				ids,
				HashSet.union(
					setAt(before.membersByRealm, r),
					setAt(inserted.membersByRealm, r),
				),
			),
	)
	const consumers = HashSet.reduce(
		newSlots,
		HashSet.union(touched, realmMembers),
		(ids, key) =>
			HashSet.union(
				ids,
				HashSet.union(
					setAt(before.slotConsumers, key),
					setAt(inserted.slotConsumers, key),
				),
			),
	)
	return HashSet.reduce(consumers, inserted, resolveMember)
}
const realmMembers = (
	before: GraphTopology,
	after: GraphTopology,
	realms: ReadonlyArray<RealmDeclaration>,
): HashSet.HashSet<string> =>
	HashSet.reduce(
		HashSet.union(touchedRealms(before, realms), touchedRealms(after, realms)),
		HashSet.empty<string>(),
		(ids, id) =>
			HashSet.union(
				ids,
				HashSet.union(
					setAt(before.membersByRealm, id),
					setAt(after.membersByRealm, id),
				),
			),
	)
const patch = (
	before: GraphTopology,
	proposal: GraphProposal,
): Result.Result<GraphTopology, Fault> => {
	const resolved = edit(before, proposal)
	const touched = HashSet.fromIterable([
		...proposal.removed,
		...Array.map(proposal.members, (m) => m.instance),
	])
	const region = expand(
		HashSet.union(touched, realmMembers(before, resolved, proposal.realms)),
		(id) => HashSet.union(oldMembers(before, id), neighbors(resolved, id)),
	)
	return rebuildGroups(before, resolved, region)
}
/** Apply only cells owned by this plan; unrelated topology remains current. */
export const commit = (
	current: GraphTopology,
	plan: GroupPlan,
	recovering: boolean,
): GraphTopology => {
	const declarations = recovering ? plan.previous : plan.desired
	const realms = recovering ? plan.previousRealms : plan.desiredRealms
	const withoutRealms = HashMap.reduce(realms, current, (g, value, key) => {
		if (Option.isSome(value)) return g
		const previous = HashMap.get(g.realms, key)
		return {
			...g,
			realms: HashMap.remove(g.realms, key),
			childRealms: Option.match(
				Option.flatMap(previous, (r) => r.parent),
				{
					onNone: () => g.childRealms,
					onSome: (parent) => remove(g.childRealms, parent, key),
				},
			),
		}
	})
	const changed = edit(withoutRealms, {
		members: Array.fromIterable(HashMap.values(declarations)),
		removed: HashSet.difference(
			plan.members,
			HashSet.fromIterable(HashMap.keys(declarations)),
		),
		explicit: plan.members,
		realms: Array.flatMap(
			Array.fromIterable(HashMap.values(realms)),
			Option.toArray,
		),
	})
	const removedGroups = HashMap.reduce(
		plan.newGroups,
		HashMap.reduce(plan.recoveryGroups, changed.groups, (out, _, key) =>
			HashMap.remove(out, key),
		),
		(out, _, key) => HashMap.remove(out, key),
	)
	const groups = recovering ? plan.recoveryGroups : plan.newGroups
	return {
		...changed,
		groups: HashMap.reduce(groups, removedGroups, (out, group, key) =>
			HashMap.set(out, key, group),
		),
		memberships: HashMap.reduce(
			groups,
			HashSet.reduce(plan.members, changed.memberships, (out, id) =>
				HashMap.remove(out, id),
			),
			(out, group) =>
				HashSet.reduce(group.members, out, (out, id) =>
					HashMap.set(out, id, group.id),
				),
		),
		nextGroup: Num.max(current.nextGroup, plan.nextGroup),
	}
}

export const initialize = (
	members: ReadonlyArray<MemberDeclaration>,
	realms: ReadonlyArray<RealmDeclaration>,
): Result.Result<GraphTopology, Fault> => {
	const base = Array.reduce(realms, empty(), realm)
	return patch(base, {
		members,
		removed: HashSet.empty(),
		explicit: HashSet.fromIterable(Array.map(members, (m) => m.instance)),
		realms: [],
	})
}
interface Closure {
	readonly members: HashSet.HashSet<string>
	readonly reasons: HashMap.HashMap<string, HashSet.HashSet<SelectionReason>>
}
const select = (
	out: Closure,
	id: string,
	kind: SelectionReason["kind"],
	from: string,
): Closure => ({
	members: HashSet.add(out.members, id),
	reasons: HashMap.set(
		out.reasons,
		id,
		HashSet.add(
			Option.getOrElse(
				HashMap.get(out.reasons, id),
				HashSet.empty<SelectionReason>,
			),
			new Data.Class<SelectionReason>({ kind, from }),
		),
	),
})
const selectAll = (
	out: Closure,
	ids: HashSet.HashSet<string>,
	kind: SelectionReason["kind"],
	from: string,
): Closure =>
	HashSet.reduce(ids, out, (next, id) =>
		id === from ? next : select(next, id, kind, from),
	)
/** Members that actually share a unit today; after recovery these can differ from the desired groups. */
type CoResidents = (id: string) => HashSet.HashSet<string>
const coResidents =
	(state: State): CoResidents =>
	(id) =>
		Option.match(Executions.current(state, id), {
			onNone: () => HashSet.empty<string>(),
			onSome: ({ unit }) => HashSet.fromIterable(HashMap.keys(unit.members)),
		})
const closeMember = (
	old: GraphTopology,
	next: GraphTopology,
	actual: CoResidents,
	out: Closure,
	id: string,
): Closure => {
	const grouped = selectAll(
		selectAll(
			out,
			HashSet.union(oldMembers(old, id), actual(id)),
			"OldGroup",
			id,
		),
		oldMembers(next, id),
		"NewGroup",
		id,
	)
	const descendants = selectAll(
		grouped,
		HashSet.union(setAt(old.children, id), setAt(next.children, id)),
		"StructuralChild",
		id,
	)
	const local = selectAll(
		descendants,
		HashSet.union(
			setAt(old.localConsumers, id),
			setAt(next.localConsumers, id),
		),
		"LocalDependency",
		id,
	)
	return HashSet.reduce(
		setAt(old.contractConsumers, id),
		local,
		(out, consumer) => {
			const lost = Array.some(
				dependencies(old, consumer),
				(d) =>
					d.kind === "Contract" &&
					!d.optional &&
					Option.contains(d.provider, id) &&
					!Array.some(
						dependencies(next, consumer),
						(n) =>
							n.kind === "Contract" &&
							n.service === d.service &&
							Option.isSome(n.provider),
					),
			)
			return lost ? select(out, consumer, "ContractProviderLost", id) : out
		},
	)
}
const closure = (
	old: GraphTopology,
	next: GraphTopology,
	actual: CoResidents,
	out: Closure,
): Closure => {
	const expanded = HashSet.reduce(out.members, out, (out, id) =>
		closeMember(old, next, actual, out, id),
	)
	return HashSet.size(expanded.members) === HashSet.size(out.members)
		? expanded
		: closure(old, next, actual, expanded)
}
const selectedGroups = (
	g: GraphTopology,
	ids: HashSet.HashSet<string>,
): HashMap.HashMap<string, DeploymentGroup> =>
	HashSet.reduce(ids, HashMap.empty<string, DeploymentGroup>(), (out, id) =>
		Option.match(
			Option.flatMap(HashMap.get(g.memberships, id), (key) =>
				HashMap.get(g.groups, key),
			),
			{
				onNone: () => out,
				onSome: (group) => HashMap.set(out, group.id, group),
			},
		),
	)
const selectedDeclarations = (
	g: GraphTopology,
	ids: HashSet.HashSet<string>,
): HashMap.HashMap<string, MemberDeclaration> =>
	HashSet.reduce(ids, HashMap.empty<string, MemberDeclaration>(), (out, id) =>
		Option.match(HashMap.get(g.declarations, id), {
			onNone: () => out,
			onSome: (m) => HashMap.set(out, id, m),
		}),
	)
const validRealm = (
	g: GraphTopology,
	id: string,
	seen: HashSet.HashSet<string> = HashSet.empty(),
): boolean =>
	!HashSet.has(seen, id) &&
	Option.exists(HashMap.get(g.realms, id), (r) =>
		Option.match(r.parent, {
			onNone: () => true,
			onSome: (parent) => validRealm(g, parent, HashSet.add(seen, id)),
		}),
	)
const realmPath = (
	g: GraphTopology,
	id: string,
	seen: HashSet.HashSet<string> = HashSet.empty(),
): HashSet.HashSet<string> =>
	HashSet.has(seen, id)
		? HashSet.empty()
		: HashSet.add(
				Option.match(
					Option.flatMap(HashMap.get(g.realms, id), (r) => r.parent),
					{
						onNone: () => HashSet.empty<string>(),
						onSome: (parent) => realmPath(g, parent, HashSet.add(seen, id)),
					},
				),
				`realm:${id}`,
			)
const validateMember = (g: GraphTopology, id: string): Option.Option<Fault> =>
	Option.flatMap(HashMap.get(g.declarations, id), (m) => {
		if (!validRealm(g, m.realm))
			return Option.some(
				fault(
					"InvalidDeclaration",
					[id, m.realm],
					"A member names an invalid realm ancestry",
				),
			)
		if (Option.isSome(m.parent) && !HashMap.has(g.declarations, m.parent.value))
			return Option.some(
				fault(
					"InvalidDeclaration",
					[id, m.parent.value],
					"A declared Scope child has no parent",
				),
			)
		const invalid = Array.findFirst(
			dependencies(g, id),
			(d) => d.ambiguous || (!d.optional && Option.isNone(d.provider)),
		)
		if (Option.isSome(invalid))
			return Option.some(
				fault(
					invalid.value.ambiguous ? "AmbiguousProvider" : "MissingProvider",
					[id, ...invalid.value.slots],
					"A required service has no unique compatible provider",
				),
			)
		return Array.findFirst(
			Array.flatMap(m.resources, (r) => {
				const conflicts = HashSet.filter(
					setAt(g.resourceOwners, r.key),
					(other) =>
						other !== id &&
						Option.exists(HashMap.get(g.declarations, other), (member) =>
							Array.some(
								member.resources,
								(other) =>
									other.key === r.key &&
									(r.mode === "Exclusive" || other.mode === "Exclusive"),
							),
						),
				)
				return HashSet.size(conflicts) === 0
					? []
					: [
							fault(
								"ResourceConflict",
								HashSet.add(conflicts, id),
								"Exclusive resource requirements cannot coexist",
							),
						]
			}),
			() => true,
		)
	})
const waves = (
	g: GraphTopology,
	ids: HashSet.HashSet<string>,
	out: ReadonlyArray<HashSet.HashSet<string>> = [],
): Result.Result<ReadonlyArray<HashSet.HashSet<string>>, Fault> => {
	if (HashSet.size(ids) === 0) return Result.succeed(out)
	const ready = HashSet.filter(
		ids,
		(id) =>
			Array.every(
				dependencies(g, id),
				(d) => !Option.exists(d.provider, (p) => HashSet.has(ids, p)),
			) &&
			Option.match(
				Option.flatMap(HashMap.get(g.declarations, id), (m) => m.parent),
				{ onNone: () => true, onSome: (p) => !HashSet.has(ids, p) },
			),
	)
	return HashSet.size(ready) === 0
		? Result.fail(
				fault(
					"DependencyCycle",
					ids,
					"The member startup graph contains a dependency or Scope cycle",
				),
			)
		: waves(g, HashSet.difference(ids, ready), Array.append(out, ready))
}
const reservationKeys = (
	before: GraphTopology,
	after: GraphTopology,
	ids: HashSet.HashSet<string>,
	recoveryGroups: HashMap.HashMap<string, DeploymentGroup>,
	newGroups: HashMap.HashMap<string, DeploymentGroup>,
) => {
	const memberships = HashSet.fromIterable([
		...Array.map(Array.fromIterable(HashMap.keys(recoveryGroups)), membership),
		...Array.map(Array.fromIterable(HashMap.keys(newGroups)), membership),
	])
	return HashSet.reduce(
		ids,
		{
			membershipCells: memberships,
			absenceCells: HashSet.empty<string>(),
			reads: HashSet.union(ids, memberships),
			writes: HashSet.union(ids, memberships),
			leases: HashSet.empty<string>(),
			participants: HashSet.empty<string>(),
		},
		(out, id) => {
			const declarations = [
				...Option.toArray(HashMap.get(before.declarations, id)),
				...Option.toArray(HashMap.get(after.declarations, id)),
			]
			const slots = HashSet.fromIterable(Array.flatMap(declarations, provided))
			const used = [...dependencies(before, id), ...dependencies(after, id)]
			const realmReads = Array.reduce(declarations, out.reads, (keys, m) =>
				HashSet.union(
					keys,
					HashSet.union(realmPath(before, m.realm), realmPath(after, m.realm)),
				),
			)
			const reads = Array.reduce(
				used,
				HashSet.add(
					HashSet.add(HashSet.union(realmReads, slots), memberSlot(id)),
					`authorization:${id}`,
				),
				(reads, d) =>
					Option.match(d.provider, {
						onNone: () => HashSet.union(reads, d.slots),
						onSome: (p) =>
							HashSet.add(
								HashSet.add(HashSet.union(reads, d.slots), p),
								`authorization:${p}`,
							),
					}),
			)
			const resources = Array.flatMap(declarations, (m) => m.resources)
			return {
				...out,
				reads: Array.reduce(resources, reads, (keys, r) =>
					HashSet.add(keys, resource(r.key)),
				),
				writes: Array.reduce(
					resources,
					HashSet.union(HashSet.add(out.writes, memberSlot(id)), slots),
					(keys, r) =>
						r.mode === "Exclusive" ? HashSet.add(keys, resource(r.key)) : keys,
				),
				leases: Array.reduce(
					used,
					Array.reduce(resources, out.leases, (keys, r) =>
						HashSet.add(keys, resource(r.key)),
					),
					(keys, d) =>
						Option.match(d.provider, {
							onNone: () => keys,
							onSome: (p) => HashSet.add(keys, p),
						}),
				),
				absenceCells: Array.reduce(used, out.absenceCells, (keys, d) =>
					HashSet.reduce(d.slots, keys, (keys, key) =>
						String.startsWith("slot:")(key) &&
						HashSet.size(setAt(after.providers, key)) === 0
							? HashSet.add(keys, key)
							: keys,
					),
				),
				participants: HashSet.union(
					out.participants,
					HashSet.union(
						setAt(before.contractConsumers, id),
						setAt(after.contractConsumers, id),
					),
				),
			}
		},
	)
}
const contractPatch = (
	before: GraphTopology,
	after: GraphTopology,
	selected: HashSet.HashSet<string>,
	realms: ReadonlyArray<RealmDeclaration>,
) => {
	const affected = HashSet.reduce(
		selected,
		HashSet.union(selected, realmMembers(before, after, realms)),
		(ids, id) =>
			HashSet.union(
				ids,
				HashSet.union(
					setAt(before.contractConsumers, id),
					setAt(after.contractConsumers, id),
				),
			),
	)
	return HashSet.reduce(
		affected,
		{
			consumers: HashSet.empty<string>(),
			reads: HashSet.empty<string>(),
			writes: HashSet.empty<string>(),
		},
		(out, id) => {
			const previous = dependencies(before, id)
			const desired = dependencies(after, id)
			const changed = !Equal.equals(previous, desired)
			const bindings = Array.filter(
				[...previous, ...desired],
				(d) =>
					d.kind === "Contract" &&
					(changed ||
						HashSet.has(selected, id) ||
						Option.exists(d.provider, (p) => HashSet.has(selected, p))),
			)
			if (bindings.length === 0) return out
			return {
				consumers: HashSet.add(out.consumers, id),
				reads: Array.reduce(
					bindings,
					HashSet.add(HashSet.add(out.reads, id), `authorization:${id}`),
					(keys, d) =>
						Option.match(d.provider, {
							onNone: () => HashSet.union(keys, d.slots),
							onSome: (p) =>
								HashSet.add(
									HashSet.add(HashSet.union(keys, d.slots), p),
									`authorization:${p}`,
								),
						}),
				),
				writes: Array.reduce(bindings, out.writes, (keys, d) =>
					HashSet.add(keys, Bindings.key(id, d.service)),
				),
			}
		},
	)
}
const selection = (
	before: GraphTopology,
	after: GraphTopology,
	actual: CoResidents,
	proposal: GraphProposal,
): Closure => {
	const explicit: Closure = HashSet.reduce(
		proposal.explicit,
		{
			members: HashSet.empty<string>(),
			reasons: HashMap.empty<string, HashSet.HashSet<SelectionReason>>(),
		},
		(out, id) => select(out, id, "ExplicitTarget", id),
	)
	const realmChanged = HashSet.reduce(
		realmMembers(before, after, proposal.realms),
		explicit,
		(out, id) => {
			const old = dependencies(before, id)
			const next = dependencies(after, id)
			const localChanged = Array.some(
				[...old, ...next],
				(d) =>
					d.kind === "Local" &&
					!Array.some(
						d.kind === "Local" && Array.contains(old, d) ? next : old,
						(n) =>
							n.kind === "Local" &&
							n.service === d.service &&
							Equal.equals(n.provider, d.provider),
					),
			)
			const lost = Array.some(
				old,
				(d) =>
					d.kind === "Contract" &&
					!d.optional &&
					!Array.some(
						next,
						(n) =>
							n.kind === "Contract" &&
							n.service === d.service &&
							Option.isSome(n.provider),
					),
			)
			return localChanged
				? select(out, id, "LocalDependency", id)
				: lost
					? select(out, id, "ContractProviderLost", id)
					: out
		},
	)
	return closure(before, after, actual, realmChanged)
}
const validateSelection = (
	before: GraphTopology,
	after: GraphTopology,
	proposal: GraphProposal,
	selected: Closure,
	strategy: Strategy,
): Option.Option<Fault> => {
	const outside = Array.findFirst(
		proposal.members,
		(m) =>
			!HashSet.has(selected.members, m.instance) &&
			!Option.exists(HashMap.get(before.declarations, m.instance), (old) =>
				Equal.equals(old, m),
			),
	)
	const absent = HashSet.union(
		HashSet.difference(proposal.removed, selected.members),
		HashSet.filter(
			selected.members,
			(id) =>
				!HashMap.has(before.declarations, id) &&
				!HashMap.has(after.declarations, id),
		),
	)
	if (Option.isSome(outside) || HashSet.size(absent) > 0)
		return Option.some(
			fault(
				"InvalidDeclaration",
				Option.match(outside, {
					onNone: () => absent,
					onSome: (m) => HashSet.add(absent, m.instance),
				}),
				"A proposed change lies outside the requested closure or names no declaration",
			),
		)

	const invalid = HashSet.reduce(
		selected.members,
		Option.none<Fault>(),
		(found, id) => (Option.isSome(found) ? found : validateMember(after, id)),
	)
	if (Option.isSome(invalid)) return invalid
	const moved = [
		...HashMap.values(selectedDeclarations(before, selected.members)),
		...HashMap.values(selectedDeclarations(after, selected.members)),
	]
	if (
		strategy === "Overlap" &&
		Array.some(
			moved,
			(m) =>
				!m.overlap ||
				m.placement.pipe(Option.exists((p) => p.kind === "Runner")) ||
				Array.some(m.resources, (r) => !r.overlap),
		)
	)
		return Option.some(
			fault(
				"IneligibleOverlap",
				selected.members,
				"Every moved member, resource and placement must permit Overlap",
			),
		)
	return Option.none()
}
/** Units that currently host any selected member, which may differ from the desired groups after recovery. */
const currentUnits = (
	state: State,
	ids: HashSet.HashSet<string>,
): HashSet.HashSet<string> =>
	HashSet.reduce(ids, HashSet.empty<string>(), (out, id) =>
		Option.match(
			Option.flatMap(HashMap.get(state.instances, id), (i) => i.current),
			{ onNone: () => out, onSome: (unit) => HashSet.add(out, unit) },
		),
	)
const assemblePlan = (
	state: State,
	after: GraphTopology,
	proposal: GraphProposal,
	selected: Closure,
	strategy: Strategy,
	startWaves: ReadonlyArray<HashSet.HashSet<string>>,
	recoveryWaves: ReadonlyArray<HashSet.HashSet<string>>,
): GroupPlan => {
	const previous = selectedDeclarations(state.graph, selected.members)
	const desired = selectedDeclarations(after, selected.members)
	const recoveryGroups = selectedGroups(state.graph, selected.members)
	const newGroups = selectedGroups(after, selected.members)
	const memberKeys = reservationKeys(
		state.graph,
		after,
		selected.members,
		recoveryGroups,
		newGroups,
	)
	const realmKeys = HashSet.fromIterable(
		Array.map(proposal.realms, (r) => `realm:${r.id}`),
	)
	const realmReads = Array.reduce(
		proposal.realms,
		HashSet.empty<string>(),
		(keys, r) =>
			HashSet.union(
				keys,
				HashSet.union(realmPath(state.graph, r.id), realmPath(after, r.id)),
			),
	)
	const contracts = contractPatch(
		state.graph,
		after,
		selected.members,
		proposal.realms,
	)
	const keys = {
		...memberKeys,
		reads: HashSet.union(
			HashSet.union(memberKeys.reads, contracts.reads),
			HashSet.union(HashSet.union(realmKeys, realmReads), contracts.writes),
		),
		writes: HashSet.union(
			HashSet.union(memberKeys.writes, contracts.writes),
			realmKeys,
		),
	}
	const oldUnits = currentUnits(state, selected.members)
	const participants = HashSet.reduce(
		HashSet.difference(
			HashSet.union(keys.participants, contracts.consumers),
			selected.members,
		),
		HashSet.empty<string>(),
		(out, id) =>
			Option.match(
				Option.flatMap(HashMap.get(state.instances, id), (i) => i.current),
				{
					onNone: () => out,
					onSome: (unit) => HashSet.add(out, unit),
				},
			),
	)
	return {
		...selected,
		...keys,
		previousRealms: HashMap.fromIterable(
			Array.map(proposal.realms, (r) => [
				r.id,
				HashMap.get(state.graph.realms, r.id),
			]),
		),
		desiredRealms: HashMap.fromIterable(
			Array.map(proposal.realms, (r) => [r.id, Option.some(r)]),
		),
		participants,
		recoveryGroups,
		newGroups,
		previous,
		desired,
		previousDependencies: HashMap.fromIterable(
			Array.map(
				Array.fromIterable(
					HashSet.union(selected.members, contracts.consumers),
				),
				(id) => [id, dependencies(state.graph, id)],
			),
		),
		dependencies: HashMap.fromIterable(
			Array.map(
				Array.fromIterable(
					HashSet.union(selected.members, contracts.consumers),
				),
				(id) => [id, dependencies(after, id)],
			),
		),
		startWaves,
		stopWaves: Array.reverse(recoveryWaves),
		recoveryWaves,
		peakUnits:
			strategy === "Overlap"
				? HashSet.size(oldUnits) + HashMap.size(newGroups)
				: Num.max(HashSet.size(oldUnits), HashMap.size(newGroups)),
		oldUnitCount: HashSet.size(oldUnits),
		newUnitCount: HashMap.size(newGroups),
		nextGroup: after.nextGroup,
		proposal,
	}
}
export const plan = (
	state: State,
	input: GraphProposal,
	strategy: Strategy,
): Result.Result<GroupPlan, Fault> => {
	const proposal = Snapshot.proposal(input)
	const declaredIds = HashSet.fromIterable(
		Array.map(proposal.members, (m) => m.instance),
	)
	if (
		HashSet.size(declaredIds) !== proposal.members.length ||
		HashSet.size(
			HashSet.fromIterable(Array.map(proposal.realms, (r) => r.id)),
		) !== proposal.realms.length ||
		HashSet.some(proposal.removed, (id) => HashSet.has(declaredIds, id))
	)
		return Result.fail(
			fault(
				"InvalidDeclaration",
				declaredIds,
				"Each changed instance has exactly one desired declaration or removal",
			),
		)
	return Result.flatMap(patch(state.graph, proposal), (after) => {
		const badRealm = Array.findFirst(
			proposal.realms,
			(r) => !validRealm(after, r.id),
		)
		if (Option.isSome(badRealm))
			return Result.fail(
				fault(
					"InvalidDeclaration",
					[badRealm.value.id],
					"Realm ancestry must name existing parents without cycles",
				),
			)
		const selected = selection(state.graph, after, coResidents(state), proposal)
		const invalid = validateSelection(
			state.graph,
			after,
			proposal,
			selected,
			strategy,
		)
		if (Option.isSome(invalid)) return Result.fail(invalid.value)
		return Result.flatMap(
			waves(
				after,
				HashSet.fromIterable(
					HashMap.keys(selectedDeclarations(after, selected.members)),
				),
			),
			(start) =>
				Result.map(
					waves(
						state.graph,
						HashSet.fromIterable(
							HashMap.keys(selectedDeclarations(state.graph, selected.members)),
						),
					),
					(recovery) =>
						assemblePlan(
							state,
							after,
							proposal,
							selected,
							strategy,
							start,
							recovery,
						),
				),
		)
	})
}
