import { Effect, Option, Schema, TxRef } from "effect"

import type { Runtime } from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import * as T from "./trustModel"

export interface State {
	readonly authority: Option.Option<T.Authority>
	readonly closed: boolean
	readonly used: boolean
}
export const empty: State = {
	authority: Option.none(),
	closed: false,
	used: false,
}
const same = Schema.toEquivalence(Schema.Json)
export const admission = (
	runtime: Runtime,
	entry: string,
	candidate?: string,
) =>
	Effect.gen(function* () {
		const state = yield* TxRef.get(runtime.trust)
		if (state.closed)
			return yield* T.Unapproved.make({ entry, reason: "Closed" })
		if (Option.isNone(state.authority)) {
			yield* TxRef.set(runtime.trust, { ...state, used: true })
			return
		}
		if (candidate === undefined)
			return yield* T.Unapproved.make({ entry, reason: "UnregisteredAttempt" })
		const comparison = yield* state.authority.value.compare(entry, candidate)
		if (Option.isNone(comparison.approved))
			return yield* T.Unapproved.make({ entry, reason: comparison.missing })
		if (!same(comparison.current, comparison.approved.value))
			return yield* T.Unapproved.make({ entry, reason: "ChangedStatement" })
	})
export const check = Effect.fnUntraced(function* (
	entry: string,
	candidate?: string,
) {
	const { runtime } = yield* RuntimeContext
	yield* admission(runtime, entry, candidate).pipe(Effect.tx)
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
					return yield* T.RegistrationError.make({
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
	values: ReadonlyArray<T.Projection>,
) {
	const { runtime } = yield* RuntimeContext
	yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(runtime.trust)
			if (state.closed)
				return yield* T.RegistrationError.make({
					message: "Admission authority is closed",
				})
			if (Option.isSome(state.authority))
				return yield* state.authority.value.publish(values)
			yield* TxRef.set(runtime.trust, { ...state, used: true })
		}),
	)
})
