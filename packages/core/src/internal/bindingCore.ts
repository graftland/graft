import { Array, HashMap, HashSet, Option } from "effect"

import type {
	BindingDeclaration,
	BindingFault,
	BindingRoute,
	Change,
	FixedBinding,
	MemberOperation,
	RouteView,
	State,
	Unit,
} from "./decisionState"
import * as Executions from "./executionState"
import * as Attempt from "./groupAttempt"

export const key = (consumer: string, service: string): string =>
	`binding:${consumer.length}:${consumer}:${service}`
const fault = (
	service: string,
	reason: BindingFault["reason"],
): Option.Option<BindingFault> => Option.some({ service, reason })
const duplicate = (d: BindingDeclaration): boolean =>
	HashSet.size(
		HashSet.fromIterable(Array.map(d.operations, (o) => o.identity)),
	) !== d.operations.length
export const validate = (
	required: BindingDeclaration,
	provided: BindingDeclaration,
): Option.Option<BindingFault> => {
	if (required.key !== provided.key)
		return fault(required.key, "MissingBinding")
	if (!required.unary || !provided.unary)
		return fault(required.key, "UnsupportedCallShape")
	if (duplicate(required) || duplicate(provided))
		return fault(required.key, "DuplicateOperation")
	return Array.reduce(
		required.operations,
		Option.none<BindingFault>(),
		(result, expected) => {
			if (Option.isSome(result)) return result
			const actual = Array.findFirst(
				provided.operations,
				(o) => o.identity === expected.identity,
			)
			if (Option.isNone(actual)) return fault(required.key, "MissingOperation")
			if (actual.value.provenance !== expected.provenance)
				return fault(required.key, "ProvenanceMismatch")
			return actual.value.tag !== expected.tag
				? fault(required.key, "WireTagMismatch")
				: result
		},
	)
}
export const index = (entries: ReadonlyArray<FixedBinding>) =>
	Array.reduce(
		entries,
		{
			bindings: HashMap.empty<string, FixedBinding>(),
			bindingConflicts: HashSet.empty<string>(),
			providerBindings: HashMap.empty<string, HashSet.HashSet<string>>(),
			consumerBindings: HashMap.empty<string, HashSet.HashSet<string>>(),
		},
		(s, b) => {
			const id = key(b.consumer, b.service)
			return {
				bindings: HashMap.set(s.bindings, id, Object.freeze({ ...b })),
				bindingConflicts: HashMap.has(s.bindings, id)
					? HashSet.add(s.bindingConflicts, id)
					: s.bindingConflicts,
				providerBindings: HashMap.set(
					s.providerBindings,
					b.provider,
					HashSet.add(
						Option.getOrElse(HashMap.get(s.providerBindings, b.provider), () =>
							HashSet.empty<string>(),
						),
						id,
					),
				),
				consumerBindings: HashMap.set(
					s.consumerBindings,
					b.consumer,
					HashSet.add(
						Option.getOrElse(HashMap.get(s.consumerBindings, b.consumer), () =>
							HashSet.empty<string>(),
						),
						id,
					),
				),
			}
		},
	)
export const incoming = (s: State, instance: string): HashSet.HashSet<string> =>
	Option.getOrElse(HashMap.get(s.consumerBindings, instance), () =>
		HashSet.empty<string>(),
	)
export const outgoing = (s: State, instance: string): HashSet.HashSet<string> =>
	Option.getOrElse(HashMap.get(s.providerBindings, instance), () =>
		HashSet.empty<string>(),
	)

const current = (s: State, instance: string): Option.Option<Unit> =>
	Option.flatMap(
		Option.filter(HashMap.get(s.instances, instance), () =>
			Executions.healthy(s, instance),
		),
		(i) =>
			Option.flatMap(i.current, (id) =>
				Option.filter(
					HashMap.get(s.units, id),
					(u) => u.evidence === "Missing" && u.phase === "Running",
				),
			),
	)
const planned = (c: Change): HashMap.HashMap<string, FixedBinding> =>
	HashMap.reduce(
		c.recovering ? c.plan.previousDependencies : c.plan.dependencies,
		HashMap.empty<string, FixedBinding>(),
		(bindings, dependencies, consumer) =>
			Array.reduce(dependencies, bindings, (bindings, dependency) =>
				dependency.kind === "Contract"
					? Option.match(dependency.provider, {
							onNone: () => bindings,
							onSome: (provider) =>
								HashMap.set(bindings, key(consumer, dependency.service), {
									consumer,
									provider,
									service: dependency.service,
								}),
						})
					: bindings,
			),
	)
const affectedKeys = (c: Change): HashSet.HashSet<string> =>
	HashSet.union(
		HashMap.reduce(
			c.plan.previousDependencies,
			HashSet.empty<string>(),
			(ids, dependencies, consumer) =>
				Array.reduce(dependencies, ids, (ids, dependency) =>
					dependency.kind === "Contract"
						? HashSet.add(ids, key(consumer, dependency.service))
						: ids,
				),
		),
		HashMap.reduce(
			c.plan.dependencies,
			HashSet.empty<string>(),
			(ids, dependencies, consumer) =>
				Array.reduce(dependencies, ids, (ids, dependency) =>
					dependency.kind === "Contract"
						? HashSet.add(ids, key(consumer, dependency.service))
						: ids,
				),
		),
	)
const route = (
	s: State,
	c: Change,
	id: string,
	b: FixedBinding,
): Option.Option<BindingRoute> => {
	const provider = HashSet.has(c.plan.members, b.provider)
		? Attempt.unitFor(s, c, b.provider)
		: current(s, b.provider)
	return Option.flatMap(provider, (unit) =>
		Option.flatMap(HashMap.get(unit.members, b.provider), (member) =>
			Option.map(member.endpoint, (endpoint) => ({
				...b,
				id,
				unit: unit.id,
				incarnation: unit.incarnation,
				term: member.term,
				generation: member.generation,
				endpoint,
				version:
					Option.getOrElse(
						Option.map(HashMap.get(s.cells, id), (cell) => cell.version),
						() => 0,
					) + (HashSet.has(c.request.writes, id) ? 1 : 0),
			})),
		),
	)
}
export const view = (s: State, c: Change): RouteView => ({
	routes: Array.flatMap(Array.fromIterable(planned(c)), ([id, binding]) =>
		Option.toArray(route(s, c, id, binding)),
	),
})
export const commit = (s: State, c: Change): State["routes"] =>
	Array.reduce(
		view(s, c).routes,
		HashSet.reduce(affectedKeys(c), s.routes, (routes, id) =>
			HashMap.remove(routes, id),
		),
		(routes, route) => HashMap.set(routes, route.id, route),
	)
export const activeView = (s: State, c: Change): RouteView => ({
	routes: Array.flatMap(Array.fromIterable(affectedKeys(c)), (id) =>
		Option.toArray(HashMap.get(s.routes, id)),
	),
})
export const adopt = (
	s: State,
	c: Change,
): Pick<State, "bindings" | "providerBindings" | "consumerBindings"> => {
	const removed = HashSet.reduce(
		affectedKeys(c),
		{
			bindings: s.bindings,
			providerBindings: s.providerBindings,
			consumerBindings: s.consumerBindings,
		},
		(out, id) =>
			Option.match(HashMap.get(out.bindings, id), {
				onNone: () => out,
				onSome: (binding) => ({
					bindings: HashMap.remove(out.bindings, id),
					providerBindings: HashMap.modify(
						out.providerBindings,
						binding.provider,
						HashSet.remove(id),
					),
					consumerBindings: HashMap.modify(
						out.consumerBindings,
						binding.consumer,
						HashSet.remove(id),
					),
				}),
			}),
	)
	return HashMap.reduce(planned(c), removed, (out, binding, id) => ({
		bindings: HashMap.set(out.bindings, id, binding),
		providerBindings: HashMap.set(
			out.providerBindings,
			binding.provider,
			HashSet.add(
				Option.getOrElse(
					HashMap.get(out.providerBindings, binding.provider),
					HashSet.empty<string>,
				),
				id,
			),
		),
		consumerBindings: HashMap.set(
			out.consumerBindings,
			binding.consumer,
			HashSet.add(
				Option.getOrElse(
					HashMap.get(out.consumerBindings, binding.consumer),
					HashSet.empty<string>,
				),
				id,
			),
		),
	}))
}

export const memberBindings = (
	s: State,
	members: HashSet.HashSet<string>,
): HashSet.HashSet<string> =>
	HashSet.reduce(members, HashSet.empty<string>(), (ids, member) =>
		HashSet.union(ids, HashSet.union(incoming(s, member), outgoing(s, member))),
	)
export const memberView = (
	s: State,
	operation: MemberOperation,
): RouteView => ({
	routes: Array.flatMap(
		Array.fromIterable(memberBindings(s, operation.members)),
		(id) =>
			Option.toArray(
				Option.flatMap(HashMap.get(s.bindings, id), (binding) =>
					Option.flatMap(
						Executions.current(s, binding.provider),
						({ unit, member }) =>
							Option.map(member.endpoint, (endpoint) => ({
								...binding,
								id,
								unit: unit.id,
								incarnation: unit.incarnation,
								term: member.term,
								generation: member.generation,
								endpoint,
								version:
									Option.getOrElse(
										Option.map(
											HashMap.get(s.cells, id),
											(cell) => cell.version,
										),
										() => 0,
									) +
									(operation.phase === "Activating" ||
									operation.phase === "Completed"
										? 0
										: 1),
							})),
					),
				),
			),
	),
})
