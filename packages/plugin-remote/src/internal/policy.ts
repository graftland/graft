import {
	Array,
	Cause,
	Clock,
	Context,
	Effect,
	Exit,
	Option,
	Order,
	Schema,
	Scope,
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
	readonly bindings: ReadonlyArray<Binding>
	readonly projections: ReadonlyArray<Trust.Projection>
	readonly declarations: ReadonlyArray<{
		readonly entry: string
		readonly identity: T.Identity
		readonly services: ReadonlyArray<string>
	}>
	readonly approvals: ReadonlyArray<T.Approval>
	readonly revocations: ReadonlyArray<string>
	readonly reclaimers: ReadonlyArray<Reclaimer>
}
export const empty: State = {
	policy: Option.none(),
	closed: false,
	bindings: [],
	projections: [],
	declarations: [],
	approvals: [],
	revocations: [],
	reclaimers: [],
}
class Store extends Context.Service<Store, TxRef.TxRef<State>>()(
	"@graftland/plugin-remote/internal/policy/Store",
) {}

const sameIdentity = (a: T.Identity, b: T.Identity) =>
	a.package === b.package && a.digest === b.digest
const same = Schema.toEquivalence(T.Statement)
const sameAssignment = Schema.toEquivalence(T.Assignment)
const snapshot = Trust.immutable
const mergeProjections = (
	previous: ReadonlyArray<Trust.Projection>,
	values: ReadonlyArray<Trust.Projection>,
) =>
	Array.reduce(values, previous, (items, next) => [
		...Array.filter(
			items,
			(item) =>
				item.projection !== next.projection ||
				item.service !== next.service ||
				item.operation !== next.operation,
		),
		next,
	])
const current = (
	state: State,
	entry: string,
	identity: T.Identity,
): Option.Option<T.Statement> => {
	if (Option.isNone(state.policy)) return Option.none()
	const assignment = Array.findFirst(
		state.policy.value.entries,
		(item) => item.entry === entry && sameIdentity(item.artifact, identity),
	)
	if (Option.isNone(assignment)) return Option.none()
	const keys = Array.flatMap(
		Array.filter(
			state.declarations,
			(binding) =>
				binding.entry === entry && sameIdentity(binding.identity, identity),
		),
		(binding: State["declarations"][number]) => binding.services,
	)
	const projections = Array.sortBy(
		Order.mapInput(Order.String, (item: Trust.Projection) => item.projection),
		Order.mapInput(Order.String, (item: Trust.Projection) => item.service),
		Order.mapInput(Order.String, (item: Trust.Projection) => item.operation),
	)(
		Array.filter(state.projections, (item) =>
			Array.contains(keys, item.service),
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
		Array.contains(state.revocations, reference),
	)
const rejected = (entry: string, reason: T.Unapproved["reason"]) =>
	T.Unapproved.make({ entry, reason })
const comparison = Effect.fnUntraced(function* (
	entry: string,
	candidate: string,
) {
	const stateRef = yield* Store
	const state = yield* TxRef.get(stateRef)
	if (state.closed) return yield* rejected(entry, "Closed")
	const binding = Array.findFirst(
		state.bindings,
		(item) => item.entry === entry && item.candidate === candidate,
	)
	if (Option.isNone(binding)) return yield* rejected(entry, "UnknownArtifact")
	const selected = current(state, entry, binding.value.identity)
	if (Option.isNone(selected)) return yield* rejected(entry, "UnknownArtifact")
	const matching = Array.findLast(state.approvals, (record) =>
		same(record.statement, selected.value),
	)
	if (
		revoked(state, selected.value) &&
		!(Option.isSome(matching) && matching.value.overrideRevocations)
	)
		return yield* rejected(entry, "Revoked")
	const previous = Option.orElse(matching, () =>
		Array.findLast(
			state.approvals,
			(record) => record.statement.assignment.entry === entry,
		),
	)
	return {
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
export const install = Effect.fnUntraced(function* (
	policy: T.Policy,
	approvals: ReadonlyArray<T.Approval> = [],
	revocations: ReadonlyArray<string> = [],
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

	const stateRef = yield* TxRef.make<State>({
		...empty,
		policy: Option.some(snapshot(decoded)),
		approvals: snapshot(approvals),
		revocations: snapshot(revocations),
		projections: snapshot(
			mergeProjections(
				[],
				Array.flatMap(approvals, (record) => record.statement.projections),
			),
		),
	})
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
			Effect.map((state) => state.bindings.length),
		),
	})
	const { close } = yield* Trust.register({
		services: Context.make(Service, methods),
		compare: (entry, candidate) => provide(comparison(entry, candidate)),
		publish: (values) => provide(publish(values)),
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
				(state) => [state.reclaimers, { ...state, closed: true }] as const,
			)
			yield* terminateAll(owners)
		}).pipe(Effect.orDie),
	)
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
					Array.some(
						state.bindings,
						(binding) =>
							binding.entry !== entry &&
							Array.some(services, (key) =>
								Array.contains(binding.services, key),
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
				yield* TxRef.set(stateRef, {
					...state,
					bindings: [...state.bindings, binding],
					declarations: [
						...Array.filter(
							state.declarations,
							(item) =>
								item.entry !== entry || !sameIdentity(item.identity, identity),
						),
						{
							entry,
							identity: snapshot(identity),
							services: snapshot(services),
						},
					],
				})
				return Option.isSome(assignment)
					? assignment.value.assignment
					: undefined
			}),
		),
		() =>
			TxRef.update(stateRef, (state) => ({
				...state,
				bindings: Array.filter(state.bindings, (item) => item.token !== token),
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
const publish = Effect.fnUntraced(function* (
	values: ReadonlyArray<Trust.Projection>,
) {
	const stateRef = yield* Store
	const decoded = yield* Schema.decodeEffect(Schema.Array(Trust.Projection))(
		values,
	).pipe(
		Effect.mapError((error) =>
			Trust.RegistrationError.make({
				message: "Invalid projection payload",
				cause: Cause.fail(error),
			}),
		),
	)
	yield* TxRef.update(stateRef, (state) => ({
		...state,
		projections: mergeProjections(state.projections, snapshot(decoded)),
	}))
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
				...state,
				approvals: [
					...Array.filter(
						state.approvals,
						(item) => !same(item.statement, record.statement),
					),
					snapshot(record),
				],
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
			reclaimers: [...state.reclaimers, reclaimer],
		})),
		() =>
			TxRef.update(stateRef, (state) => ({
				...state,
				reclaimers: Array.filter(
					state.reclaimers,
					(item) => item !== reclaimer,
				),
			})),
	)
	const state = yield* TxRef.get(stateRef)
	const binding = Array.findFirst(
		state.bindings,
		(item) => item.entry === entry && item.candidate === candidate,
	)
	if (state.closed) return yield* terminateAll([reclaimer])
	if (Option.isSome(binding)) {
		const selected = current(state, entry, binding.value.identity)
		if (
			Option.isSome(selected) &&
			revoked(state, selected.value) &&
			!Array.some(
				state.approvals,
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
			const next = {
				...state,
				revocations: Array.dedupe([...state.revocations, ...refs]),
				approvals: Array.filter(
					state.approvals,
					(record) =>
						!Array.some(references(record.statement), (ref) =>
							Array.contains(refs, ref),
						),
				),
			}
			yield* TxRef.set(stateRef, next)
			return Array.filter(next.reclaimers, (item) => {
				const binding = Array.findFirst(
					next.bindings,
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
			})
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
