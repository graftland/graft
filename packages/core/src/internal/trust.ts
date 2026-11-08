import {
	Array,
	Cause,
	Effect,
	Exit,
	Option,
	Schema,
	Scope,
	Semaphore,
	TxRef,
} from "effect"

import type { Runtime } from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import * as T from "./trustModel"

export interface State {
	readonly authority: Option.Option<T.Authority>
	readonly closed: boolean
	readonly owners: ReadonlyArray<{
		readonly projection: string
		readonly view: string
		readonly token: object
		readonly closing: boolean
	}>
	readonly used: boolean
}
export const empty: State = {
	authority: Option.none(),
	closed: false,
	used: false,
	owners: [],
}
const same = Schema.toEquivalence(Schema.Json)
export interface Condition {
	readonly authority: Option.Option<T.Authority>
	readonly instance: string
	readonly attempt: string
	readonly revision: number
}
export const snapshot = Effect.fnUntraced(function* (
	runtime: Runtime,
	instance: string,
	attempt: string,
) {
	yield* admission(runtime, instance, attempt)
	const state = yield* TxRef.get(runtime.trust)
	const revision = Option.isNone(state.authority)
		? 0
		: (yield* state.authority.value.compare(instance, attempt)).revision
	return {
		authority: state.authority,
		instance,
		attempt,
		revision,
	} satisfies Condition
})
export const verify = Effect.fnUntraced(function* (
	runtime: Runtime,
	condition: Condition,
) {
	const state = yield* TxRef.get(runtime.trust)
	if (state.closed)
		return yield* T.Unapproved.make({
			instance: condition.instance,
			reason: "Closed",
		})
	if (
		!Option.makeEquivalence((a: T.Authority, b: T.Authority) => a === b)(
			state.authority,
			condition.authority,
		)
	)
		return yield* T.Unapproved.make({
			instance: condition.instance,
			reason: "AuthorityChanged",
		})
	if (Option.isNone(state.authority)) return
	const comparison = yield* state.authority.value.compare(
		condition.instance,
		condition.attempt,
	)
	if (comparison.revision !== condition.revision)
		return yield* T.Unapproved.make({
			instance: condition.instance,
			reason: `Authorization version changed from ${condition.revision} to ${comparison.revision}`,
		})
})
export const admission = (
	runtime: Runtime,
	instance: string,
	attempt?: string,
) =>
	Effect.gen(function* () {
		const state = yield* TxRef.get(runtime.trust)
		if (state.closed)
			return yield* T.Unapproved.make({ instance, reason: "Closed" })
		if (Option.isNone(state.authority)) {
			yield* TxRef.set(runtime.trust, { ...state, used: true })
			return
		}
		if (attempt === undefined)
			return yield* T.Unapproved.make({
				instance,
				reason: "UnregisteredAttempt",
			})
		const comparison = yield* state.authority.value.compare(instance, attempt)
		if (Option.isNone(comparison.approved))
			return yield* T.Unapproved.make({ instance, reason: comparison.missing })
		if (!same(comparison.current, comparison.approved.value))
			return yield* T.Unapproved.make({ instance, reason: "ChangedStatement" })
	})
export const check = Effect.fnUntraced(function* (
	instance: string,
	attempt?: string,
) {
	const { runtime } = yield* RuntimeContext
	yield* admission(runtime, instance, attempt).pipe(Effect.tx)
})
export const register = Effect.fnUntraced(function* (authority: T.Authority) {
	const { runtime } = yield* RuntimeContext
	const close = TxRef.update(runtime.trust, (state) => ({
		...state,
		closed: true,
	}))
	yield* Effect.acquireRelease(
		Effect.tx(
			Effect.gen(function* () {
				const previous = yield* TxRef.get(runtime.trust)
				if (
					previous.closed ||
					previous.used ||
					Option.isSome(previous.authority)
				)
					return yield* T.AdmissionRegistrationError.make({
						message:
							"Install one admission authority before entries or projections are used",
					})
				yield* TxRef.set(runtime.trust, {
					...empty,
					authority: Option.some(authority),
				})
			}),
		),
		() => close,
	)
	return { close }
})
export const publish = Effect.fnUntraced(function* (
	publication: T.Publication,
) {
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const initial = yield* Schema.decodeEffect(T.Publication)(
				publication,
			).pipe(
				Effect.mapError((error) =>
					T.AdmissionRegistrationError.make({
						message: "Invalid logical view publication",
						cause: Cause.fail(error),
					}),
				),
			)
			const identity = { projection: initial.projection, view: initial.view }
			const token = {}
			const mutex = yield* Semaphore.make(1)
			const parent = yield* Effect.scope
			const owner = yield* Scope.fork(parent)
			const acquire = Effect.acquireRelease(
				Effect.tx(
					Effect.gen(function* () {
						const state = yield* TxRef.get(runtime.trust)
						if (state.closed)
							return yield* T.AdmissionRegistrationError.make({
								message: "Admission authority is closed",
							})
						if (
							Array.some(
								state.owners,
								(owner) =>
									owner.projection === identity.projection &&
									owner.view === identity.view,
							)
						)
							return yield* T.ProjectionConflict.make(identity)
						yield* TxRef.set(runtime.trust, {
							...state,
							used: true,
							owners: [...state.owners, { ...identity, token, closing: false }],
						})
					}),
				),
				() =>
					Effect.gen(function* () {
						yield* TxRef.update(runtime.trust, (state) => ({
							...state,
							owners: Array.map(state.owners, (item) =>
								item.token === token ? { ...item, closing: true } : item,
							),
						}))
						yield* mutex.withPermit(
							TxRef.update(runtime.trust, (state) => ({
								...state,
								owners: Array.filter(
									state.owners,
									(item) => item.token !== token,
								),
							})),
						)
					}),
			).pipe(Scope.provide(owner))
			const update: T.Publisher["update"] = (values) =>
				mutex.withPermit(
					Effect.gen(function* () {
						const authority = yield* Effect.tx(
							Effect.gen(function* () {
								const state = yield* TxRef.get(runtime.trust)
								if (
									state.closed ||
									!Array.some(
										state.owners,
										(owner) => owner.token === token && !owner.closing,
									)
								)
									return yield* T.AdmissionRegistrationError.make({
										message: "Logical view owner is closed",
									})
								return state.authority
							}),
						)
						if (Option.isSome(authority))
							yield* authority.value.publish({ ...identity, values })
					}),
				)
			yield* acquire.pipe(
				Effect.andThen(restore(update(initial.values))),
				Effect.onExit((exit) =>
					Exit.isFailure(exit) ? Scope.close(owner, exit) : Effect.void,
				),
			)
			return { update } satisfies T.Publisher
		}),
	)
})
