import {
	Array,
	Cause,
	Clock,
	Effect,
	Exit,
	Option,
	Order,
	Schema,
	TxRef,
} from "effect"

import type { Runtime } from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import * as T from "./trustModel"

interface Binding {
	readonly entry: string
	readonly candidate: string
	readonly identity: T.Identity
	readonly services: ReadonlyArray<string>
}
interface Presentation {
	readonly owner: object
	readonly descriptions: ReadonlyArray<T.Description>
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
	readonly presentations: ReadonlyArray<Presentation>
	readonly approvals: ReadonlyArray<T.Approval>
	readonly revocations: ReadonlyArray<string>
	readonly reclaimers: ReadonlyArray<Reclaimer>
}
export const empty: State = {
	policy: Option.none(),
	closed: false,
	bindings: [],
	presentations: [],
	approvals: [],
	revocations: [],
	reclaimers: [],
}
const sameIdentity = (a: T.Identity, b: T.Identity) =>
	a.package === b.package && a.digest === b.digest
const same = Schema.toEquivalence(T.Statement)
const sameAssignment = Schema.toEquivalence(T.Assignment)
const snapshot = <A>(value: A): A => structuredClone(value)
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
		Array.filter(state.bindings, (binding) => binding.entry === entry),
		(binding: Binding) => binding.services,
	)
	const descriptions = Array.sortBy(
		Order.mapInput(Order.String, (item: T.Description) => item.service),
		Order.mapInput(Order.String, (item: T.Description) => item.operation),
	)(
		Array.filter(
			Array.flatMap(state.presentations, (item) => item.descriptions),
			(item) => Array.contains(keys, item.service),
		),
	)
	return Option.some(
		snapshot({
			assignment: assignment.value,
			policyVersion: state.policy.value.version,
			descriptions,
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
export const admission = (runtime: Runtime, entry: string, candidate: string) =>
	Effect.gen(function* () {
		const state = yield* TxRef.get(runtime.trust)
		if (state.closed) return yield* rejected(entry, "Closed")
		if (Option.isNone(state.policy)) return
		const binding = Array.findFirst(
			state.bindings,
			(item) => item.entry === entry && item.candidate === candidate,
		)
		if (Option.isNone(binding)) return yield* rejected(entry, "UnknownArtifact")
		const statement = current(state, entry, binding.value.identity)
		if (Option.isNone(statement))
			return yield* rejected(entry, "UnknownArtifact")
		const approval = Array.findLast(state.approvals, (record) =>
			same(record.statement, statement.value),
		)
		if (
			revoked(state, statement.value) &&
			!(Option.isSome(approval) && approval.value.overrideRevocations)
		)
			return yield* rejected(entry, "Revoked")
		if (Option.isNone(approval))
			return yield* rejected(
				entry,
				Array.some(
					state.approvals,
					(record) => record.statement.assignment.entry === entry,
				)
					? "ChangedStatement"
					: "MissingApproval",
			)
	})
export const check = Effect.fnUntraced(function* (
	entry: string,
	candidate: string,
) {
	const { runtime } = yield* RuntimeContext
	yield* admission(runtime, entry, candidate).pipe(Effect.tx)
})
const terminateAll = Effect.fnUntraced(function* (
	reclaimers: ReadonlyArray<Reclaimer>,
) {
	const exits = yield* Effect.forEach(
		reclaimers,
		(item) => Effect.exit(item.terminate.pipe(Effect.timeout("5 seconds"))),
		{ concurrency: 4 },
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
	const { runtime } = yield* RuntimeContext
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
	yield* Effect.acquireRelease(
		Effect.tx(
			Effect.gen(function* () {
				const previous = yield* TxRef.get(runtime.trust)
				if (
					Option.isSome(previous.policy) ||
					previous.closed ||
					previous.bindings.length > 0
				)
					return yield* T.PolicyError.make({
						message:
							"Install operator policy once, before managed entries start",
					})
				yield* TxRef.set(runtime.trust, {
					...empty,
					policy: Option.some(snapshot(decoded)),
					approvals: snapshot(approvals),
					revocations: snapshot(revocations),
				})
			}),
		),
		() =>
			Effect.gen(function* () {
				const owners = yield* TxRef.modify(
					runtime.trust,
					(state) => [state.reclaimers, { ...state, closed: true }] as const,
				)
				yield* terminateAll(owners)
			}).pipe(Effect.orDie),
	)
})
export const bind = Effect.fnUntraced(function* (
	entry: string,
	candidate: string,
	identity: T.Identity,
	services: ReadonlyArray<string>,
) {
	const { runtime } = yield* RuntimeContext
	return yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(runtime.trust)
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
				entry,
				candidate,
				identity: snapshot(identity),
				services: snapshot(services),
			}
			yield* TxRef.set(runtime.trust, {
				...state,
				bindings: [
					...Array.filter(
						state.bindings,
						(item) => item.entry !== entry || item.candidate !== candidate,
					),
					binding,
				],
			})
			return Option.isSome(assignment) ? assignment.value.assignment : undefined
		}),
	)
})
export const statement = Effect.fnUntraced(function* (
	entry: string,
	identity: T.Identity,
) {
	const { runtime } = yield* RuntimeContext
	const state = yield* TxRef.get(runtime.trust)
	return yield* Option.match(current(state, entry, identity), {
		onNone: () => rejected(entry, "UnknownArtifact"),
		onSome: Effect.succeed,
	})
})
export const describe = Effect.fnUntraced(function* (
	owner: object,
	descriptions: ReadonlyArray<T.Description>,
) {
	const { runtime } = yield* RuntimeContext
	const decoded = yield* Schema.decodeEffect(Schema.Array(T.Description))(
		descriptions,
	).pipe(
		Effect.mapError((error) =>
			T.PolicyError.make({
				message: "Invalid exposed descriptions",
				cause: Cause.fail(error),
			}),
		),
	)
	yield* TxRef.update(runtime.trust, (state) => ({
		...state,
		presentations: [
			...Array.filter(state.presentations, (item) => item.owner !== owner),
			{ owner, descriptions: snapshot(decoded) },
		],
	}))
})
export const withdraw = Effect.fnUntraced(function* (owner: object) {
	const { runtime } = yield* RuntimeContext
	yield* TxRef.update(runtime.trust, (state) => ({
		...state,
		presentations: Array.filter(
			state.presentations,
			(item) => item.owner !== owner,
		),
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
	const { runtime } = yield* RuntimeContext
	const state = yield* TxRef.get(runtime.trust)
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
	const { runtime } = yield* RuntimeContext
	yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(runtime.trust)
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
			yield* TxRef.set(runtime.trust, {
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
	const { runtime } = yield* RuntimeContext
	const reclaimer: Reclaimer = { entry, candidate, terminate }
	yield* Effect.acquireRelease(
		TxRef.update(runtime.trust, (state) => ({
			...state,
			reclaimers: [...state.reclaimers, reclaimer],
		})),
		() =>
			TxRef.update(runtime.trust, (state) => ({
				...state,
				reclaimers: Array.filter(
					state.reclaimers,
					(item) => item !== reclaimer,
				),
			})),
	)
	const state = yield* TxRef.get(runtime.trust)
	const binding = Array.findFirst(
		state.bindings,
		(item) => item.entry === entry && item.candidate === candidate,
	)
	if (state.closed) return yield* terminate
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
			yield* terminate
	}
})
export const revoke = Effect.fnUntraced(function* (
	refs: ReadonlyArray<string>,
) {
	const { runtime } = yield* RuntimeContext
	const reclaimers = yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(runtime.trust)
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
			yield* TxRef.set(runtime.trust, next)
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
	const { runtime } = yield* RuntimeContext
	const state = yield* TxRef.get(runtime.trust)
	return Option.isNone(state.policy)
		? []
		: Array.getSomes(
				Array.map(state.policy.value.entries, (entry) =>
					current(state, entry.entry, entry.artifact),
				),
			)
})

export const enabled = Effect.gen(function* () {
	const { runtime } = yield* RuntimeContext
	return Option.isSome((yield* TxRef.get(runtime.trust)).policy)
})
