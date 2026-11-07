import { Effect, Option, TxRef } from "effect"

import * as Change from "../Change"

export interface State {
	readonly maxUnits: number
	readonly used: number
	readonly reserved: number
}
export interface Claim {
	readonly pool: TxRef.TxRef<State>
	readonly state: TxRef.TxRef<{
		readonly peak: number
		readonly units: number
		readonly released: boolean
	}>
}
export interface Credit {
	readonly charged: TxRef.TxRef<boolean>
	readonly capacity: TxRef.TxRef<Option.Option<Claim>>
}

export const initial = Effect.fnUntraced(function* (pool: TxRef.TxRef<State>) {
	const state = yield* TxRef.get(pool)
	if (state.used + state.reserved + 1 > state.maxUnits)
		return yield* Change.ChangeRejected.make({
			reason: {
				_tag: "Capacity",
				maxUnits: state.maxUnits,
				required: state.used + state.reserved + 1,
			},
		})
	yield* TxRef.set(pool, { ...state, used: state.used + 1 })
})
export const reserve = Effect.fnUntraced(function* (
	pool: TxRef.TxRef<State>,
	peak: number,
	units: number,
) {
	const state = yield* TxRef.get(pool)
	const extra = peak - units
	if (state.used + state.reserved + extra > state.maxUnits)
		return yield* Change.ChangeRejected.make({
			reason: {
				_tag: "Capacity",
				maxUnits: state.maxUnits,
				required: state.used + state.reserved + extra,
			},
		})
	yield* TxRef.set(pool, { ...state, reserved: state.reserved + extra })
	const claim: Claim = {
		pool,
		state: yield* TxRef.make({ peak, units, released: false }),
	}
	return claim
})
export const take = Effect.fnUntraced(function* (claim: Claim) {
	const state = yield* TxRef.get(claim.state)
	if (state.released || state.units >= state.peak)
		return yield* Effect.die(
			new Error("A Change cannot allocate beyond its reserved unit capacity"),
		)
	yield* TxRef.set(claim.state, { ...state, units: state.units + 1 })
	yield* TxRef.update(claim.pool, (pool) => ({
		...pool,
		used: pool.used + 1,
		reserved: pool.reserved - 1,
	}))
})
/** Called only after exit or proof that the allocation can never start execution. */
export const end = Effect.fnUntraced(function* (
	pool: TxRef.TxRef<State>,
	credit: Credit,
) {
	if (!(yield* TxRef.get(credit.charged))) return
	yield* TxRef.set(credit.charged, false)
	const claim = yield* TxRef.get(credit.capacity)
	const reserved =
		Option.isSome(claim) && !(yield* TxRef.get(claim.value.state)).released
	if (Option.isSome(claim))
		yield* TxRef.update(claim.value.state, (state) => ({
			...state,
			units: state.units - 1,
		}))
	yield* TxRef.update(pool, (state) => ({
		...state,
		used: state.used - 1,
		reserved: state.reserved + (reserved ? 1 : 0),
	}))
})
export const release = Effect.fnUntraced(function* (claim: Claim) {
	const state = yield* TxRef.get(claim.state)
	if (state.released) return
	yield* TxRef.set(claim.state, { ...state, released: true })
	yield* TxRef.update(claim.pool, (pool) => ({
		...pool,
		reserved: pool.reserved - (state.peak - state.units),
	}))
})
