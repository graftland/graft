import { Array, Cause, Effect, Exit, HashMap, Option, Ref, TxRef } from "effect"

import type * as Change from "../Change"
import * as ChangeTable from "./changeTable"
import type { HostLease, Managed } from "./transition"

/** Original ownership evidence determines current facts, independently of the recorded outcome. */
export const read = Effect.fnUntraced(function* (
	lease: HostLease,
): Effect.fn.Return<Change.Settlement> {
	const termination = yield* TxRef.get(lease.terminated)
	const host = yield* Ref.get(lease.hostRelease.state)
	return {
		generation: lease.id,
		execution: Option.match(termination, {
			onNone: () => "Unconfirmed",
			onSome: (value) => value.state,
		}),
		cleanup:
			host._tag !== "Completed"
				? "Pending"
				: Exit.isSuccess(host.exit)
					? "Completed"
					: Cause.hasInterruptsOnly(host.exit.cause)
						? "Unknown"
						: "Failed",
		cause: Cause.combine(
			Option.flatMap(termination, (value) =>
				Option.fromUndefinedOr(value.cause),
			).pipe(Option.getOrElse(() => Cause.empty)),
			host._tag === "Completed" && Exit.isFailure(host.exit)
				? host.exit.cause
				: Cause.empty,
		),
	}
})
const merge = (
	previous: ReadonlyArray<Change.Settlement>,
	next: ReadonlyArray<Change.Settlement>,
) =>
	Array.reduce(next, previous, (all, fact) => {
		const old = Array.findFirst(
			all,
			(item) => item.generation === fact.generation,
		)
		return [
			...Array.filter(all, (item) => item.generation !== fact.generation),
			Option.isNone(old)
				? fact
				: {
						...fact,
						execution:
							fact.execution === "Unconfirmed"
								? old.value.execution
								: fact.execution,
						cleanup:
							fact.cleanup === "Pending" ? old.value.cleanup : fact.cleanup,
						cause: Cause.fromReasons(
							Array.dedupe([...old.value.cause.reasons, ...fact.cause.reasons]),
						),
					},
		]
	})
export const observe = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	next: ReadonlyArray<Change.Settlement>,
	change: (status: Change.Status) => Change.Status = (status) => status,
) {
	const leases = yield* TxRef.get(managed.leases)
	const node = yield* TxRef.get(managed.entry.node.state)
	const leaseHolders = Array.map(
		Array.filter(leases, (lease) =>
			Option.exists(
				HashMap.get(node.resolutions, lease.generation),
				(resolution) => resolution.provisions.length > 0,
			),
		),
		(lease) => lease.id,
	)

	yield* ChangeTable.update(managed.runtime.changes, record, (current) => {
		const status = change(current)
		const settlement = merge(status.settlement, next)
		return {
			...status,
			settlement,
			leaseHolders,
			unconfirmedUnits: Array.map(
				Array.filter(settlement, (fact) => fact.execution === "Unconfirmed"),
				(fact) => fact.generation,
			),
		}
	})
}, Effect.tx)
