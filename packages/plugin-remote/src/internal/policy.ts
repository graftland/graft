import {
	Array,
	Cause,
	Clock,
	Context,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Option,
	Order,
	Schema,
	Scope,
	Semaphore,
	TxRef,
} from "effect"

import { Trust } from "@graftland/graft"

import { termination } from "./policyLimits"
import * as T from "./policyModel"

interface Binding {
	readonly token: object
	readonly entry: string
	readonly candidate: string
	readonly identity: T.Identity
	readonly services: ReadonlyArray<string>
}
interface Reclaimer {
	readonly entry: string
	readonly candidate: string
	readonly terminate: Effect.Effect<void, T.PolicyError>
}
export interface State {
	readonly policy: Option.Option<T.Policy>
	readonly closed: boolean
	readonly revisions: HashMap.HashMap<string, number>
	readonly bindings: HashMap.HashMap<string, ReadonlyArray<Binding>>
	readonly bindingCount: number
	readonly serviceOwners: HashMap.HashMap<
		string,
		{ readonly entry: string; readonly count: number }
	>
	readonly assignments: HashMap.HashMap<string, ReadonlyArray<T.Assignment>>
	readonly projectionsByService: HashMap.HashMap<
		string,
		ReadonlyArray<Trust.Projection>
	>
	readonly projections: ReadonlyArray<Trust.Projection>
	readonly declarations: HashMap.HashMap<
		string,
		ReadonlyArray<{
			readonly entry: string
			readonly identity: T.Identity
			readonly services: ReadonlyArray<string>
		}>
	>
	readonly approvals: HashMap.HashMap<string, ReadonlyArray<T.Approval>>
	readonly revocations: HashSet.HashSet<string>
	readonly reclaimers: HashMap.HashMap<string, ReadonlyArray<Reclaimer>>
}
export const empty: State = {
	policy: Option.none(),
	closed: false,
	revisions: HashMap.empty(),
	bindings: HashMap.empty(),
	bindingCount: 0,
	serviceOwners: HashMap.empty(),
	assignments: HashMap.empty(),
	projectionsByService: HashMap.empty(),
	projections: [],
	declarations: HashMap.empty(),
	approvals: HashMap.empty(),
	revocations: HashSet.empty(),
	reclaimers: HashMap.empty(),
}
export class Store extends Context.Service<Store, TxRef.TxRef<State>>()(
	"@graftland/plugin-remote/internal/policy/Store",
) {}

/** Entry tombstones survive binding removal and distinguish authorization ABA. */
const revise = (state: State, entries: ReadonlyArray<string>): State => ({
	...state,
	revisions: Array.reduce(
		Array.dedupe(entries),
		state.revisions,
		(versions, entry) =>
			HashMap.set(
				versions,
				entry,
				Option.getOrElse(HashMap.get(versions, entry), () => 0) + 1,
			),
	),
})
const entries = <A>(
	index: HashMap.HashMap<string, ReadonlyArray<A>>,
	key: string,
) => Option.getOrElse(HashMap.get(index, key), () => [])
const group = <A>(values: ReadonlyArray<A>, key: (value: A) => string) =>
	Array.reduce(
		values,
		HashMap.empty<string, ReadonlyArray<A>>(),
		(all, value) =>
			HashMap.set(all, key(value), [...entries(all, key(value)), value]),
	)
export const initial = (
	policy: T.Policy,
	approvals: ReadonlyArray<T.Approval> = [],
	revocations: ReadonlyArray<string> = [],
	projections: ReadonlyArray<Trust.Projection> = [],
): State => ({
	...empty,
	policy: Option.some(snapshot(policy)),
	assignments: group(snapshot(policy.entries), (item) => item.entry),
	approvals: group(
		snapshot(approvals),
		(item) => item.statement.assignment.entry,
	),
	revocations: HashSet.fromIterable(revocations),
	projections: snapshot(projections),
	projectionsByService: group(snapshot(projections), (item) => item.service),
})
const sameIdentity = (a: T.Identity, b: T.Identity) =>
	a.package === b.package && a.digest === b.digest
const same = Schema.toEquivalence(T.Statement)
const sameAssignment = Schema.toEquivalence(T.Assignment)
// Operator data is copied on ingress and egress; comparison uses schema structural equality.
const snapshot = <A extends Schema.Json>(value: A): A => structuredClone(value)
const sameView = (a: Trust.View, b: Trust.View) =>
	a.projection === b.projection && a.view === b.view
const replaceView = (
	previous: ReadonlyArray<Trust.Projection>,
	publication: Trust.Publication,
) => [
	...Array.filter(previous, (item) => !sameView(item, publication)),
	...Array.map(publication.values, (value) => ({
		...value,
		projection: publication.projection,
		view: publication.view,
	})),
]
const current = (
	state: State,
	entry: string,
	identity: T.Identity,
): Option.Option<T.Statement> => {
	if (Option.isNone(state.policy)) return Option.none()
	const assignment = Array.findFirst(
		entries(state.assignments, entry),
		(item) => sameIdentity(item.artifact, identity),
	)
	if (Option.isNone(assignment)) return Option.none()
	const declaration = Array.findFirst(
		entries(state.declarations, entry),
		(binding) => sameIdentity(binding.identity, identity),
	)
	const keys = Option.isSome(declaration) ? declaration.value.services : []
	const projections = Array.sortBy(
		Order.mapInput(Order.String, (item: Trust.Projection) => item.projection),
		Order.mapInput(Order.String, (item: Trust.Projection) => item.view),
		Order.mapInput(Order.String, (item: Trust.Projection) => item.service),
		Order.mapInput(Order.String, (item: Trust.Projection) => item.operation),
	)(
		Array.flatMap(Array.dedupe(keys), (key) =>
			entries(state.projectionsByService, key),
		),
	)
	return Option.some(
		snapshot({
			assignment: assignment.value,
			policyVersion: state.policy.value.version,
			projections,
		}),
	)
}
const references = (statement: T.Statement) =>
	Array.flatMap(statement.assignment.grants, (grant) =>
		grant._tag === "Http" && grant.credential !== undefined
			? [grant.id, "env:" + grant.credential]
			: [grant.id],
	)
const revoked = (state: State, statement: T.Statement) =>
	Array.some(references(statement), (reference) =>
		HashSet.has(state.revocations, reference),
	)
const rejected = (entry: string, reason: T.Unapproved["reason"]) =>
	T.Unapproved.make({ entry, reason })
export const comparison = Effect.fnUntraced(function* (
	entry: string,
	candidate: string,
) {
	const stateRef = yield* Store
	const state = yield* TxRef.get(stateRef)
	if (state.closed) return yield* rejected(entry, "Closed")
	const binding = Array.findFirst(
		entries(state.bindings, entry),
		(item) => item.entry === entry && item.candidate === candidate,
	)
	if (Option.isNone(binding)) return yield* rejected(entry, "UnknownArtifact")
	const selected = current(state, entry, binding.value.identity)
	if (Option.isNone(selected)) return yield* rejected(entry, "UnknownArtifact")
	const matching = Array.findLast(entries(state.approvals, entry), (record) =>
		same(record.statement, selected.value),
	)
	if (
		revoked(state, selected.value) &&
		!(Option.isSome(matching) && matching.value.overrideRevocations)
	)
		return yield* rejected(entry, "Revoked")
	const previous = Option.orElse(matching, () =>
		Array.findLast(
			entries(state.approvals, entry),
			(record) => record.statement.assignment.entry === entry,
		),
	)
	return {
		revision: Option.getOrElse(HashMap.get(state.revisions, entry), () => 0),
		current: selected.value,
		approved: Option.map(previous, (record) => record.statement),
		missing: "MissingApproval",
	} satisfies Trust.Comparison
})
const terminateAll = Effect.fnUntraced(function* (
	reclaimers: ReadonlyArray<Reclaimer>,
) {
	const exits = yield* Effect.forEach(
		reclaimers,
		(item) =>
			Effect.exit(item.terminate.pipe(Effect.timeout(termination.timeout))),
		{ concurrency: termination.concurrency },
	)
	const cause = Array.reduce(
		exits,
		Cause.empty as Cause.Cause<unknown>,
		(cause, exit) =>
			Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause,
	)
	if (cause.reasons.length > 0)
		return yield* T.PolicyError.make({
			message: "Admission is closed but unit termination failed",
			cause,
		})
})
/** Installs the authority for this scope and returns its service for ordinary context provision. */
export const install = Effect.fnUntraced(function* (
	policy: T.Policy,
	approvals: ReadonlyArray<T.Approval> = [],
	revocations: ReadonlyArray<string> = [],
	publications: ReadonlyArray<Trust.Publication> = [],
) {
	const decoded = yield* Schema.decodeEffect(T.Policy)(policy).pipe(
		Effect.mapError((error) =>
			T.PolicyError.make({
				message: "Invalid operator policy",
				cause: Cause.fail(error),
			}),
		),
	)
	const unique = Array.dedupeWith(
		decoded.entries,
		(a, b) => a.entry === b.entry && sameIdentity(a.artifact, b.artifact),
	)
	if (
		unique.length !== decoded.entries.length ||
		Array.some(
			decoded.entries,
			(item) =>
				Array.dedupe(Array.map(item.grants, (grant) => grant.id)).length !==
				item.grants.length,
		)
	)
		return yield* T.PolicyError.make({
			message: "Policy assignments and grant ids must be unique",
		})

	const stateRef = yield* TxRef.make<State>(
		initial(
			decoded,
			approvals,
			revocations,
			Array.reduce(publications, Array.empty<Trust.Projection>(), replaceView),
		),
	)
	const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.provideService(Store, stateRef))
	const methods = Service.of({
		bind: (...args) => provide(bind(...args)),
		statement: (...args) => provide(statement(...args)),
		review: (...args) => provide(review(...args)),
		approve: (...args) => provide(approve(...args)),
		revoke: (...args) => provide(revoke(...args)),
		onRevoke: (...args) => provide(onRevoke(...args)),
		statements: provide(statements),
		bindings: TxRef.get(stateRef).pipe(
			Effect.map((state) => state.bindingCount),
		),
	})
	const audit = yield* Effect.serviceOption(Audit)
	const publicationLock = yield* Semaphore.make(1)
	const { close } = yield* Trust.register({
		compare: (entry, candidate) => provide(comparison(entry, candidate)),
		publish: (value) =>
			publicationLock.withPermit(provide(publish(value, audit))),
	}).pipe(
		Effect.mapError((error) =>
			T.PolicyError.make({ message: error.message, cause: Cause.fail(error) }),
		),
	)
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			yield* close
			const owners = yield* TxRef.modify(
				stateRef,
				(state) =>
					[
						Array.flatten(Array.fromIterable(HashMap.values(state.reclaimers))),
						{ ...state, closed: true },
					] as const,
			)
			yield* terminateAll(owners)
		}).pipe(Effect.orDie),
	)
	return methods
}, Effect.uninterruptible)
export const bind = Effect.fnUntraced(function* (
	entry: string,
	candidate: string,
	identity: T.Identity,
	services: ReadonlyArray<string>,
) {
	const stateRef = yield* Store
	const token = {}
	return yield* Effect.acquireRelease(
		Effect.tx(
			Effect.gen(function* () {
				const state = yield* TxRef.get(stateRef)
				if (state.closed) return yield* rejected(entry, "Closed")
				const assignment = current(state, entry, identity)
				if (Option.isSome(state.policy) && Option.isNone(assignment))
					return yield* rejected(entry, "UnknownArtifact")
				if (
					Option.isSome(state.policy) &&
					Array.some(services, (key) =>
						Option.exists(
							HashMap.get(state.serviceOwners, key),
							(owner) => owner.entry !== entry,
						),
					)
				)
					return yield* T.PolicyError.make({
						message: "Governed service keys must identify one entry",
					})
				const binding: Binding = {
					token,
					entry,
					candidate,
					identity: snapshot(identity),
					services: snapshot(services),
				}
				const previous = Array.findFirst(
					entries(state.declarations, entry),
					(item) =>
						item.entry === entry && sameIdentity(item.identity, identity),
				)
				const next =
					Option.isSome(previous) &&
					Schema.toEquivalence(Schema.Array(Schema.String))(
						previous.value.services,
						services,
					)
						? state
						: revise(state, [entry])
				yield* TxRef.set(stateRef, {
					...next,
					bindings: HashMap.set(state.bindings, entry, [
						...entries(state.bindings, entry),
						binding,
					]),
					bindingCount: state.bindingCount + 1,
					serviceOwners: Array.reduce(
						services,
						state.serviceOwners,
						(owners, key) =>
							HashMap.set(owners, key, {
								entry,
								count: Option.match(HashMap.get(owners, key), {
									onNone: () => 1,
									onSome: (owner) => owner.count + 1,
								}),
							}),
					),
					declarations: HashMap.set(state.declarations, entry, [
						...Array.filter(
							entries(state.declarations, entry),
							(item) =>
								item.entry !== entry || !sameIdentity(item.identity, identity),
						),
						{
							entry,
							identity: snapshot(identity),
							services: snapshot(services),
						},
					]),
				})
				return Option.isSome(assignment)
					? assignment.value.assignment
					: undefined
			}),
		),
		() =>
			TxRef.update(stateRef, (state) => ({
				...state,
				bindings: HashMap.set(
					state.bindings,
					entry,
					Array.filter(
						entries(state.bindings, entry),
						(item) => item.token !== token,
					),
				),
				bindingCount: state.bindingCount - 1,
				serviceOwners: Array.reduce(
					services,
					state.serviceOwners,
					(owners, key) =>
						Option.match(HashMap.get(owners, key), {
							onNone: () => owners,
							onSome: (owner) =>
								owner.count <= 1
									? HashMap.remove(owners, key)
									: HashMap.set(owners, key, {
											...owner,
											count: owner.count - 1,
										}),
						}),
				),
			})),
	)
})
export const statement = Effect.fnUntraced(function* (
	entry: string,
	identity: T.Identity,
) {
	const stateRef = yield* Store
	const state = yield* TxRef.get(stateRef)
	return yield* Option.match(current(state, entry, identity), {
		onNone: () => rejected(entry, "UnknownArtifact"),
		onSome: Effect.succeed,
	})
})
export const publish = Effect.fnUntraced(function* (
	publication: Trust.Publication,
	audit: Option.Option<Audit["Service"]>,
) {
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const stateRef = yield* Store
			const decoded = yield* Schema.decodeEffect(Trust.Publication)(
				snapshot(publication),
			).pipe(
				Effect.mapError((error) =>
					Trust.RegistrationError.make({
						message: "Invalid projection payload",
						cause: Cause.fail(error),
					}),
				),
			)
			const values = Array.sortBy(
				Order.mapInput(
					Order.String,
					(item: Trust.ProjectionValue) => item.service,
				),
				Order.mapInput(
					Order.String,
					(item: Trust.ProjectionValue) => item.operation,
				),
			)(decoded.values)
			if (
				Array.dedupeWith(
					values,
					(a, b) => a.service === b.service && a.operation === b.operation,
				).length !== values.length
			)
				return yield* Trust.RegistrationError.make({
					message: "A logical view must declare each service/operation once",
				})
			const after = { ...decoded, values }
			const state = yield* TxRef.get(stateRef)
			if (state.closed)
				return yield* Trust.RegistrationError.make({
					message: "Policy is closed",
				})
			const before: Trust.Publication = {
				projection: after.projection,
				view: after.view,
				values: Array.map(
					Array.filter(state.projections, (item) => sameView(item, after)),
					({ service, operation, value }) => ({ service, operation, value }),
				),
			}
			if (Schema.toEquivalence(Trust.Publication)(before, after)) return
			// Audit acknowledgement precedes admission changes and external metadata exposure.
			if (Option.isSome(audit)) {
				yield* restore(audit.value.ready)
				yield* audit.value.record(snapshot({ before, after }))
			}
			yield* Effect.tx(
				TxRef.update(stateRef, (current) => {
					const services = Array.dedupe(
						Array.map(
							[...before.values, ...after.values],
							(item) => item.service,
						),
					)
					const entries = Array.map(
						Array.filter(
							Array.flatten(
								Array.fromIterable(HashMap.values(current.declarations)),
							),
							(item) =>
								Array.some(item.services, (key) =>
									Array.contains(services, key),
								),
						),
						(item) => item.entry,
					)
					return {
						...revise(current, entries),
						projections: replaceView(current.projections, after),
						projectionsByService: group(
							replaceView(current.projections, after),
							(item) => item.service,
						),
					}
				}),
			)
		}),
	)
})
export const review = Effect.fnUntraced(function* (request: T.Approve) {
	const expected = snapshot(request.expected)
	const actual = yield* statement(
		expected.assignment.entry,
		expected.assignment.artifact,
	)
	if (!same(actual, expected))
		return yield* rejected(expected.assignment.entry, "ChangedStatement")
	const stateRef = yield* Store
	const state = yield* TxRef.get(stateRef)
	if (revoked(state, actual) && request.overrideRevocations !== true)
		return yield* rejected(expected.assignment.entry, "Revoked")
	return {
		statement: actual,
		who: request.who,
		at: yield* Clock.currentTimeMillis,
		overrideRevocations: request.overrideRevocations === true,
	} satisfies T.Approval
})
export const approve = Effect.fnUntraced(function* (record: T.Approval) {
	const stateRef = yield* Store
	yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(stateRef)
			const actual = current(
				state,
				record.statement.assignment.entry,
				record.statement.assignment.artifact,
			)
			if (Option.isNone(actual) || !same(actual.value, record.statement))
				return yield* rejected(
					record.statement.assignment.entry,
					"ChangedStatement",
				)
			yield* TxRef.set(stateRef, {
				...revise(state, [record.statement.assignment.entry]),
				approvals: HashMap.set(
					state.approvals,
					record.statement.assignment.entry,
					[
						...Array.filter(
							entries(state.approvals, record.statement.assignment.entry),
							(item) => !same(item.statement, record.statement),
						),
						snapshot(record),
					],
				),
			})
		}),
	)
})
export const onRevoke = Effect.fnUntraced(function* (
	entry: string,
	candidate: string,
	terminate: Effect.Effect<void, T.PolicyError>,
) {
	const stateRef = yield* Store
	const reclaimer: Reclaimer = { entry, candidate, terminate }
	yield* Effect.acquireRelease(
		TxRef.update(stateRef, (state) => ({
			...state,
			reclaimers: HashMap.set(state.reclaimers, entry, [
				...entries(state.reclaimers, entry),
				reclaimer,
			]),
		})),
		() =>
			TxRef.update(stateRef, (state) => ({
				...state,
				reclaimers: HashMap.set(
					state.reclaimers,
					entry,
					Array.filter(
						entries(state.reclaimers, entry),
						(item) => item !== reclaimer,
					),
				),
			})),
	)
	const state = yield* TxRef.get(stateRef)
	const binding = Array.findFirst(
		entries(state.bindings, entry),
		(item) => item.entry === entry && item.candidate === candidate,
	)
	if (state.closed) return yield* terminateAll([reclaimer])
	if (Option.isSome(binding)) {
		const selected = current(state, entry, binding.value.identity)
		if (
			Option.isSome(selected) &&
			revoked(state, selected.value) &&
			!Array.some(
				entries(state.approvals, entry),
				(record) =>
					record.overrideRevocations &&
					record.statement.policyVersion === selected.value.policyVersion &&
					sameAssignment(
						record.statement.assignment,
						selected.value.assignment,
					),
			)
		)
			yield* terminateAll([reclaimer])
	}
})
export const revoke = Effect.fnUntraced(function* (
	refs: ReadonlyArray<string>,
) {
	const stateRef = yield* Store
	const reclaimers = yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(stateRef)
			const affected = Array.dedupe(
				Option.match(state.policy, {
					onNone: () => [],
					onSome: (policy) =>
						Array.map(
							Array.filter(policy.entries, (assignment) =>
								Array.some(
									references({
										assignment,
										policyVersion: policy.version,
										projections: [],
									}),
									(ref) => Array.contains(refs, ref),
								),
							),
							(assignment) => assignment.entry,
						),
				}),
			)
			const next = {
				...revise(state, affected),
				revocations: HashSet.union(
					state.revocations,
					HashSet.fromIterable(refs),
				),
				approvals: Array.reduce(affected, state.approvals, (all, entry) =>
					HashMap.set(
						all,
						entry,
						Array.filter(
							entries(all, entry),
							(record) =>
								!Array.some(references(record.statement), (ref) =>
									Array.contains(refs, ref),
								),
						),
					),
				),
			}
			yield* TxRef.set(stateRef, next)
			return Array.filter(
				Array.flatMap(affected, (entry) => entries(next.reclaimers, entry)),
				(item) => {
					const binding = Array.findFirst(
						entries(next.bindings, item.entry),
						(binding) =>
							binding.entry === item.entry &&
							binding.candidate === item.candidate,
					)
					if (Option.isNone(binding)) return false
					const selected = current(next, item.entry, binding.value.identity)
					return (
						Option.isSome(selected) &&
						Array.some(references(selected.value), (ref) =>
							Array.contains(refs, ref),
						)
					)
				},
			)
		}),
	)
	yield* terminateAll(reclaimers)
})
export const statements = Effect.gen(function* () {
	const stateRef = yield* Store
	const state = yield* TxRef.get(stateRef)
	return Option.isNone(state.policy)
		? []
		: Array.getSomes(
				Array.map(state.policy.value.entries, (entry) =>
					current(state, entry.entry, entry.artifact),
				),
			)
})

export interface Operations {
	readonly bind: (
		entry: string,
		candidate: string,
		identity: T.Identity,
		services: ReadonlyArray<string>,
	) => Effect.Effect<
		T.Assignment | undefined,
		T.Unapproved | T.PolicyError,
		Scope.Scope
	>
	readonly statement: (
		entry: string,
		identity: T.Identity,
	) => Effect.Effect<T.Statement, T.Unapproved>
	readonly review: (
		request: T.Approve,
	) => Effect.Effect<T.Approval, T.Unapproved>
	readonly approve: (record: T.Approval) => Effect.Effect<void, T.Unapproved>
	readonly revoke: (
		references: ReadonlyArray<string>,
	) => Effect.Effect<void, T.PolicyError>
	readonly onRevoke: (
		entry: string,
		candidate: string,
		terminate: Effect.Effect<void, T.PolicyError>,
	) => Effect.Effect<void, T.PolicyError, Scope.Scope>
	readonly statements: Effect.Effect<ReadonlyArray<T.Statement>>
	/** Number of live attempt leases, including allocations that have not started. */
	readonly bindings: Effect.Effect<number>
}
export class Service extends Context.Service<Service, Operations>()(
	"@graftland/plugin-remote/internal/policy/Service",
) {}

/** Durable history supplied by the release owner; embedded hosts may supply their own sink. */
export class Audit extends Context.Service<
	Audit,
	{
		/** May wait interruptibly for the audit owner to finish initialization. */
		readonly ready: Effect.Effect<void, Trust.RegistrationError>
		readonly record: (
			change: ProjectionChange,
		) => Effect.Effect<void, Trust.RegistrationError>
	}
>()("@graftland/plugin-remote/internal/policy/Audit") {}
export const ProjectionChange = Schema.Struct({
	before: Trust.Publication,
	after: Trust.Publication,
})
export type ProjectionChange = typeof ProjectionChange.Type
