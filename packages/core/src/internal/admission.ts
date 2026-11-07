import { Context, Data, Effect, HashSet, Option, TxRef } from "effect"

import * as T from "../Transition"
import type { Attempt, Managed } from "./transition"
import * as Trust from "./trust"

export type Gate = Data.TaggedEnum<{
	Open: { readonly waiters: HashSet.HashSet<number>; readonly next: number }
	Paused: { readonly waiters: HashSet.HashSet<number>; readonly next: number }
	Closed: {
		readonly waiters: HashSet.HashSet<number>
		readonly next: number
		readonly reason: "Closing" | "RecoveryFailed"
	}
}>
export const Gate = Data.taggedEnum<Gate>()
export const initial: Gate = Gate.Open({ waiters: HashSet.empty(), next: 0 })
export const pause = (managed: Managed) =>
	TxRef.update(managed.admission, (gate): Gate =>
		gate._tag === "Closed" && gate.reason === "Closing"
			? gate
			: Gate.Paused({ waiters: gate.waiters, next: gate.next }),
	)
export const open = (managed: Managed) =>
	TxRef.update(managed.admission, (gate): Gate =>
		gate._tag === "Closed" && gate.reason === "Closing"
			? gate
			: Gate.Open({ waiters: gate.waiters, next: gate.next }),
	)
export const close = (managed: Managed, reason: "Closing" | "RecoveryFailed") =>
	TxRef.update(managed.admission, (gate): Gate =>
		Gate.Closed({ waiters: gate.waiters, next: gate.next, reason }),
	)
const rejected = (managed: Managed, reason: T.CallRejection) =>
	T.AdmissionRejected.make({ fork: managed.entry.id, reason })
const select = Effect.fnUntraced(function* (managed: Managed) {
	const selected = yield* TxRef.get(managed.route)
	if (Option.isNone(selected))
		return yield* T.Unavailable.make({ fork: managed.entry.id })
	const attempt = selected.value
	yield* Trust.admission(
		managed.runtime,
		managed.instance,
		attempt.desired.identity,
	)
	const calls = yield* TxRef.get(attempt.calls)
	if (calls >= managed.maxInFlight)
		return yield* rejected(managed, {
			_tag: "Limit",
			attempt: attempt.id,
			limit: managed.maxInFlight,
		})
	yield* TxRef.set(attempt.calls, calls + 1)
	return attempt
})
type Ticket = Data.TaggedEnum<{
	Ready: { readonly attempt: Attempt }
	Waiting: { readonly id: number }
}>
const Ticket = Data.taggedEnum<Ticket>()
const enter = Effect.fnUntraced(function* (
	managed: Managed,
): Effect.fn.Return<
	Ticket,
	T.AdmissionRejected | T.Unavailable | import("../Trust").Unapproved
> {
	const gate = yield* TxRef.get(managed.admission)
	if (gate._tag === "Closed")
		return yield* rejected(managed, { _tag: gate.reason })
	if (!(yield* TxRef.get(managed.runtime.changes.open)))
		return yield* rejected(managed, { _tag: "Closing" })
	if (gate._tag === "Open")
		return Ticket.Ready({ attempt: yield* select(managed) })
	if (HashSet.size(gate.waiters) >= managed.queue.maxWaiters)
		return yield* rejected(managed, {
			_tag: "QueueOverflow",
			limit: managed.queue.maxWaiters,
		})
	const id = gate.next
	yield* TxRef.set(managed.admission, {
		...gate,
		next: id + 1,
		waiters: HashSet.add(gate.waiters, id),
	})
	return Ticket.Waiting({ id })
}, Effect.tx)
const remove = (managed: Managed, id: number) =>
	TxRef.update(managed.admission, (gate) => ({
		...gate,
		waiters: HashSet.remove(gate.waiters, id),
	}))
const wait = Effect.fnUntraced(function* (managed: Managed, id: number) {
	const gate = yield* TxRef.get(managed.admission)
	if (gate._tag === "Closed")
		return yield* rejected(managed, { _tag: gate.reason })
	if (gate._tag === "Paused") return yield* Effect.txRetry
	const attempt = yield* select(managed)
	yield* remove(managed, id)
	return attempt
}, Effect.tx)
export const invoke =
	(managed: Managed): T.Invoke =>
	(key, use) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const ticket = yield* enter(managed)
				const attempt =
					ticket._tag === "Ready"
						? ticket.attempt
						: yield* restore(
								wait(managed, ticket.id).pipe(
									Effect.timeoutOrElse({
										duration: managed.queue.maxWait,
										orElse: () => rejected(managed, { _tag: "QueueExpired" }),
									}),
								),
							).pipe(Effect.ensuring(remove(managed, ticket.id)))
				return yield* restore(
					Effect.gen(function* () {
						const services = yield* TxRef.get(attempt.services)
						const service = Context.getOption(services, key)
						if (Option.isNone(service))
							return yield* T.Unavailable.make({ fork: managed.entry.id })
						return yield* Effect.raceFirst(use(service.value), attempt.failure)
					}),
				).pipe(
					Effect.ensuring(TxRef.update(attempt.calls, (calls) => calls - 1)),
				)
			}),
		)
