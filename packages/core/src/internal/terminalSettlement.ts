import { Array, Cause, Data, Effect, Exit, Option, Ref, TxRef } from "effect"

import type * as Change from "../Change"
import type { State as CloseState } from "./asyncClose"
import type { Record } from "./changeTable"
import type { HostLease, Managed } from "./transition"

export type Classification = Data.TaggedEnum<{
	Settled: {}
	Failed: { readonly cause: Cause.Cause<unknown> }
	Unresolved: {
		readonly reason: "UnconfirmedTermination" | "UnresolvedCleanup"
		readonly cause: Cause.Cause<unknown>
	}
}>
export const Classification = Data.taggedEnum<Classification>()
export const combine = (
	states: ReadonlyArray<Classification>,
): Classification => {
	const cause = Array.reduce(
		states,
		Cause.empty,
		(all: Cause.Cause<unknown>, state) =>
			Cause.combine(all, state._tag === "Settled" ? Cause.empty : state.cause),
	)
	const unresolved = Array.findFirst(
		states,
		(state) =>
			state._tag === "Unresolved" && state.reason === "UnconfirmedTermination",
	).pipe(
		Option.orElse(() =>
			Array.findFirst(states, (state) => state._tag === "Unresolved"),
		),
	)
	if (Option.isSome(unresolved) && unresolved.value._tag === "Unresolved")
		return Classification.Unresolved({ reason: unresolved.value.reason, cause })
	return Array.some(states, (state) => state._tag === "Failed")
		? Classification.Failed({ cause })
		: Classification.Settled()
}
export const cleanup = (state: CloseState): Classification =>
	state._tag !== "Completed"
		? Classification.Unresolved({
				reason: "UnresolvedCleanup",
				cause: Cause.empty,
			})
		: Exit.isSuccess(state.exit)
			? Classification.Settled()
			: Cause.hasInterruptsOnly(state.exit.cause)
				? Classification.Unresolved({
						reason: "UnresolvedCleanup",
						cause: state.exit.cause,
					})
				: Classification.Failed({ cause: state.exit.cause })
export const cleanupFact = (
	state: CloseState,
): NonNullable<Change.Status["preparation"]> => ({
	cleanup:
		state._tag !== "Completed"
			? "Pending"
			: classificationCleanup(cleanup(state)),
	cause:
		state._tag === "Completed" && Exit.isFailure(state.exit)
			? state.exit.cause
			: Cause.empty,
})
const classificationCleanup = (
	state: Classification,
): "Completed" | "Failed" | "Unknown" =>
	state._tag === "Settled"
		? "Completed"
		: state._tag === "Failed"
			? "Failed"
			: "Unknown"
export const generation = (
	termination: Option.Option<Change.Termination>,
	host: CloseState,
): Classification =>
	combine([
		Option.isSome(termination)
			? Classification.Settled()
			: Classification.Unresolved({
					reason: "UnconfirmedTermination",
					cause: Cause.empty,
				}),
		cleanup(host),
	])
export interface Obligation {
	readonly retiring: boolean
	readonly lease: HostLease
	readonly state: Classification
	readonly fact: Change.Settlement
}
export const read = Effect.fnUntraced(function* (
	lease: HostLease,
): Effect.fn.Return<Obligation> {
	const termination = yield* TxRef.get(lease.terminated)
	const host = yield* Ref.get(lease.hostRelease.state)
	const state = generation(termination, host)
	return {
		retiring: yield* TxRef.get(lease.retiring),
		lease,
		state,
		fact: {
			generation: lease.id,
			execution: Option.match(termination, {
				onNone: () => "Unconfirmed",
				onSome: (exit) => exit.state,
			}),
			...cleanupFact(host),
			cause: Cause.combine(
				Option.flatMap(termination, (exit) =>
					Option.fromUndefinedOr(exit.cause),
				).pipe(Option.getOrElse(() => Cause.empty)),
				host._tag === "Completed" && Exit.isFailure(host.exit)
					? host.exit.cause
					: Cause.empty,
			),
		},
	}
})
export interface Snapshot {
	readonly state: Classification
	readonly serving: Option.Option<HostLease>
	readonly generations: ReadonlyArray<Obligation>
	readonly preparation: NonNullable<Change.Status["preparation"]>
}
/** Freeze the serving generation transferred to registration ownership at terminal publication. */
const serving = Effect.fnUntraced(function* (
	managed: Managed,
): Effect.fn.Return<Option.Option<HostLease>> {
	const route = yield* TxRef.get(managed.route)
	if (Option.isNone(route)) return Option.none()
	const retiring = yield* TxRef.get(route.value.retiring)
	const termination = yield* TxRef.get(route.value.terminated)
	return !retiring && Option.isNone(termination) ? route : Option.none()
})
export const generations = Effect.fnUntraced(function* (
	managed: Managed,
	record: Record,
	transferred?: Option.Option<HostLease>,
): Effect.fn.Return<ReadonlyArray<Obligation>> {
	const owned = yield* TxRef.get(record.obligations)
	const registrationOwned = transferred ?? (yield* serving(managed))
	const facts = yield* Effect.forEach(owned, read)
	return Array.filter(
		facts,
		(fact) =>
			!Option.exists(
				registrationOwned,
				(lease) => lease.generation === fact.lease.generation,
			),
	)
})
export const classify = Effect.fnUntraced(function* (
	managed: Managed,
	record: Record,
	transferred?: Option.Option<HostLease>,
): Effect.fn.Return<Snapshot> {
	const registrationOwned = transferred ?? (yield* serving(managed))
	const obligations = yield* generations(managed, record, registrationOwned)
	const preparation = yield* record.preparation.state
	return {
		state: combine([
			...Array.map(obligations, (obligation) => obligation.state),
			cleanup(preparation),
		]),
		serving: registrationOwned,
		generations: obligations,
		preparation: cleanupFact(preparation),
	}
})
