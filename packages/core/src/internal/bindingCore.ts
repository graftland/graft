import { Array, HashMap, HashSet, Option, Result } from "effect"

import type {
	BindingDeclaration,
	BindingFault,
	BindingRoute,
	Change,
	Description,
	FixedBinding,
	Request,
	RouteView,
	State,
	Unit,
} from "./decisionState"

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
		Option.filter(
			HashMap.get(s.instances, instance),
			(i) => i.healthy && i.authorized,
		),
		(i) =>
			Option.flatMap(i.current, (id) =>
				Option.filter(
					HashMap.get(s.units, id),
					(u) => u.evidence === "Missing" && u.phase === "Running",
				),
			),
	)
const declaration = (
	d: Description,
	key: string,
	side: "requires" | "provides",
	instance: string,
): Option.Option<BindingDeclaration> =>
	Option.flatMap(
		Array.findFirst(d.members, (m) => m.instance === instance),
		(m) => Array.findFirst(m[side], (d) => d.key === key),
	)
const between = (
	required: Option.Option<BindingDeclaration>,
	provided: Option.Option<BindingDeclaration>,
	service: string,
): Option.Option<BindingFault> =>
	Option.isSome(required) && Option.isSome(provided)
		? validate(required.value, provided.value)
		: fault(service, "MissingBinding")
const checkBinding = (
	s: State,
	r: Request,
	b: FixedBinding,
): Option.Option<BindingFault> => {
	if (HashSet.has(s.bindingConflicts, key(b.consumer, b.service)))
		return fault(b.service, "MultipleProviders")
	if (r.description === undefined) return Option.none()
	const consumer =
		b.consumer === r.instance
			? Option.some(r.description)
			: Option.flatMap(current(s, b.consumer), (u) => u.description)
	const provider =
		b.provider === r.instance
			? Option.some(r.description)
			: Option.flatMap(current(s, b.provider), (u) => u.description)
	return Option.isNone(consumer) &&
		b.consumer !== r.instance &&
		!Option.exists(HashMap.get(s.instances, b.consumer), (i) =>
			Option.isSome(i.current),
		)
		? Option.none()
		: between(
				Option.flatMap(consumer, (d) =>
					declaration(d, b.service, "requires", b.consumer),
				),
				Option.flatMap(provider, (d) =>
					declaration(d, b.service, "provides", b.provider),
				),
				b.service,
			)
}
const checkedBinding = (
	s: State,
	r: Request,
	id: string,
): Option.Option<BindingFault> =>
	Option.match(HashMap.get(s.bindings, id), {
		onNone: () => fault(id, "MissingBinding"),
		onSome: (b) => checkBinding(s, r, b),
	})
const read = (s: State, r: Request, key: string): Request => ({
	...r,
	reads: HashMap.set(
		r.reads,
		key,
		Option.getOrElse(
			Option.map(HashMap.get(s.cells, key), (c) => c.version),
			() => 0,
		),
	),
})
const planEdge = (s: State, r: Request, id: string): Request =>
	Option.match(HashMap.get(s.bindings, id), {
		onNone: () => r,
		onSome: (b) => {
			const observed = read(
				s,
				read(s, r, id),
				b.provider === r.instance ? b.consumer : b.provider,
			)
			return b.provider === r.instance
				? {
						...observed,
						writes: HashSet.add(observed.writes, id),
						participants: Option.match(current(s, b.consumer), {
							onNone: () => r.participants,
							onSome: (u) =>
								u.evidence === "Missing"
									? HashSet.add(r.participants, u.id)
									: r.participants,
						}),
					}
				: observed
		},
	})
export const plan = (
	s: State,
	r: Request,
): Result.Result<Request, BindingFault> => {
	if (r.description === undefined) return Result.succeed(r)
	const required = Array.findFirst(
		Array.flatMap(r.description.members, (m) => m.requires),
		(d) => !HashMap.has(s.bindings, key(r.instance, d.key)),
	)
	if (Option.isSome(required))
		return Result.fail({
			service: required.value.key,
			reason: "MissingBinding",
		})
	const affected = HashSet.union(
		incoming(s, r.instance),
		outgoing(s, r.instance),
	)
	const invalid = HashSet.reduce(
		affected,
		Option.none<BindingFault>(),
		(found, id) => (Option.isSome(found) ? found : checkedBinding(s, r, id)),
	)
	return Option.isSome(invalid)
		? Result.fail(invalid.value)
		: Result.succeed(HashSet.reduce(affected, r, (r, id) => planEdge(s, r, id)))
}
const route = (s: State, c: Change, id: string): Option.Option<BindingRoute> =>
	Option.flatMap(HashMap.get(s.bindings, id), (b) => {
		const provider =
			b.provider === c.request.instance
				? Option.flatMap(c.candidate, (id) => HashMap.get(s.units, id))
				: current(s, b.provider)
		return Option.flatMap(provider, (u) =>
			Option.map(u.endpoint, (endpoint) => ({
				...b,
				id,
				unit: u.id,
				incarnation: u.incarnation,
				term: u.term,
				endpoint,
				version:
					Option.getOrElse(
						Option.map(HashMap.get(s.cells, id), (v) => v.version),
						() => 0,
					) + (HashSet.has(c.request.writes, id) ? 1 : 0),
			})),
		)
	})
export const view = (s: State, c: Change): RouteView => ({
	routes: Array.flatMap(
		Array.fromIterable(
			HashSet.union(
				incoming(s, c.request.instance),
				outgoing(s, c.request.instance),
			),
		),
		(id) => Option.toArray(route(s, c, id)),
	),
})
export const commit = (s: State, c: Change): State["routes"] =>
	Array.reduce(view(s, c).routes, s.routes, (routes, r) =>
		HashMap.set(routes, r.id, r),
	)

export const activeView = (s: State, c: Change): RouteView => ({
	routes: Array.flatMap(
		Array.fromIterable(
			HashSet.union(
				incoming(s, c.request.instance),
				outgoing(s, c.request.instance),
			),
		),
		(id) => Option.toArray(HashMap.get(s.routes, id)),
	),
})
