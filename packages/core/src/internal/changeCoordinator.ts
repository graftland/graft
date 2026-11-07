import { Array, Cause, Effect, Exit, HashSet, Option, TxRef } from "effect"

import * as Change from "../Change"
import type { DriverError } from "../Transition"
import * as Capacity from "./capacity"
import * as Admission from "./changeAdmission"
import { emergency, execute } from "./changeExecution"
import { prepare } from "./changePreparation"
import { deadlines, normalize } from "./changeRequest"
import * as Settlement from "./changeSettlement"
import * as ChangeTable from "./changeTable"
import * as Generations from "./generations"
import { RuntimeContext } from "./runtimeContext"
import * as Terminal from "./terminalSettlement"
import {
	engine,
	ExecutionOutcome,
	finishAllocation,
	safetyReserve,
	type Attempt,
	type HostLease,
	type Managed,
	type Run,
} from "./transition"
import type { Deadlines } from "./transitionBudgets"

const publicOutcome = Effect.fnUntraced(function* (
	record: ChangeTable.Record,
	outcome: ExecutionOutcome,
): Effect.fn.Return<Change.Outcome> {
	const status = yield* TxRef.get(record.status)
	const members = yield* Settlement.members(record, status.members)
	const result: Change.Result = {
		change: record.handle.id,
		phase: outcome.phase,
		evidence: outcome.evidence,
		members: Array.map(members, (member) => ({
			...member,
			execution: Change.Execution.Completed({
				phase: outcome.phase,
				outcome: outcome._tag,
			}),
			recoverability: {
				possible: outcome._tag !== "Stuck",
				reason:
					outcome._tag === "Stuck"
						? "Settlement obligations remain unresolved"
						: "Recovery requires fresh resolution and current authorization",
			},
		})),
	}
	switch (outcome._tag) {
		case "Accepted":
			return Change.Outcome.Accepted(result)
		case "Aborted":
			return Change.Outcome.Aborted({
				...result,
				reason: outcome.reason,
			})
		case "Recovered":
			return Change.Outcome.Recovered({
				...result,
				reason: outcome.reason,
			})
		case "RecoveryFailed":
			return Change.Outcome.RecoveryFailed({
				...result,
				reason: outcome.reason,
			})
		case "Stuck":
			return Change.Outcome.Stuck({
				...result,
				reason: outcome.reason,
			})
	}
})
const lateFact = (
	managed: Managed,
	record: ChangeTable.Record,
	next: Change.Settlement,
) => Settlement.observe(managed, record, [next])
const awaitLateExit = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	lease: HostLease,
	attempt: Option.Option<Attempt>,
): Effect.fn.Return<Change.Termination, DriverError> {
	if (Option.isNone(attempt)) return yield* finishAllocation(managed, lease)
	const known = yield* TxRef.get(attempt.value.terminated)
	if (Option.isNone(known))
		yield* Effect.suspend(() => attempt.value.unit.terminate).pipe(
			Effect.catchCause((cause) =>
				lateFact(managed, record, {
					generation: lease.id,
					execution: "Unconfirmed",
					cleanup: "Unknown",
					cause,
				}),
			),
			Effect.forkIn(managed.runtime.changes.scope),
		)
	return Option.isSome(known)
		? known.value
		: yield* Effect.suspend(() => attempt.value.unit.exited)
})
const lateSettlement = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	policy: Deadlines,
	run: Run,
) {
	const obligations = yield* Terminal.generations(managed, record)
	const unresolved = Array.filter(
		obligations,
		(obligation) => obligation.state._tag === "Unresolved",
	)
	const coordinator = engine(managed, policy, run.evidence)
	yield* Effect.forEach(
		unresolved,
		({ lease }) =>
			Effect.gen(function* () {
				const attempt = yield* TxRef.get(lease.allocated)
				const termination = yield* awaitLateExit(
					managed,
					record,
					lease,
					attempt,
				)
				yield* TxRef.set(lease.terminated, Option.some(termination))
				yield* Effect.tx(
					Generations.settle(
						managed.runtime,
						managed.entry.node,
						lease.generation,
					).pipe(Effect.andThen(Capacity.end(managed.runtime.capacity, lease))),
				)
				const fact = yield* Settlement.read(lease)
				yield* lateFact(managed, record, fact)
				yield* coordinator.releaseHost(lease)
				const closed = yield* Settlement.read(lease)
				yield* lateFact(managed, record, closed)
			}).pipe(
				Effect.catchCause((cause) =>
					lateFact(managed, record, {
						generation: lease.id,
						execution: "Unconfirmed",
						cleanup: "Unknown",
						cause,
					}),
				),
			),
		{ concurrency: 8 },
	)
	yield* record.preparation.close
	yield* record.preparation.await
	const settlement = yield* Terminal.classify(managed, record)
	yield* Settlement.observe(
		managed,
		record,
		Array.map(settlement.generations, (obligation) => obligation.fact),
		(status) => ({
			...status,
			preparation: settlement.preparation,
			evidence:
				settlement.state._tag === "Settled" ||
				settlement.state.cause.reasons.length === 0
					? status.evidence
					: [
							...status.evidence,
							{ phase: "Terminating", cause: settlement.state.cause },
						],
		}),
	)
	yield* Effect.tx(
		Effect.gen(function* () {
			if (
				yield* ChangeTable.retire(
					managed.runtime.changes,
					record,
					settlement.state,
				)
			)
				yield* TxRef.update(managed.pending, HashSet.remove(record.handle.id))
		}),
	)
})
const work = Effect.fnUntraced(function* (
	managed: Managed,
	policy: Deadlines,
	run: Run,
	record: ChangeTable.Record,
) {
	yield* TxRef.set(run.budget.reserved, safetyReserve(policy))
	const finalized = yield* execute(managed, policy, run).pipe(
		Effect.catchCause((cause) => emergency(managed, policy, run, cause)),
	)
	const published = yield* publicOutcome(record, finalized.outcome)
	yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(managed.lifecycle)
			if (
				(state._tag === "Open" || state._tag === "Closing") &&
				Option.contains(state.active, run)
			)
				yield* TxRef.set(managed.lifecycle, { ...state, active: Option.none() })
			const released = yield* ChangeTable.finish(
				managed.runtime.changes,
				record,
				published,
				finalized.settlement.state,
			)
			if (released)
				yield* TxRef.update(managed.pending, HashSet.remove(record.handle.id))
		}),
	)
	if (finalized.settlement.state._tag === "Unresolved")
		yield* Effect.interruptible(
			lateSettlement(managed, record, policy, run),
		).pipe(Effect.forkIn(managed.runtime.changes.scope))
})

export const submit = Effect.fnUntraced(function* (
	request: Change.Request,
): Effect.fn.Return<Change.Handle, Change.ChangeRejected, RuntimeContext> {
	const { runtime } = yield* RuntimeContext
	const normalized = yield* normalize(request, false)
	const preliminary = yield* Admission.preflight(runtime, request, normalized)
	if (preliminary._tag === "Duplicate") return preliminary.handle
	return yield* prepare(
		runtime,
		preliminary.managed,
		normalized.candidate,
		normalized.budget,
		(preparation) =>
			Effect.gen(function* () {
				const run = yield* Admission.makeRun(normalized)
				const admission = yield* Effect.exit(
					Admission.admit(
						runtime,
						request,
						normalized,
						run,
						preparation,
						preliminary,
					),
				)
				if (Exit.isFailure(admission)) {
					yield* preparation.close
					const cleanup = yield* Effect.timeoutOption(
						preparation.await,
						normalized.budget.terminate,
					)
					return yield* Effect.failCause(
						Cause.combine(
							admission.cause,
							Option.isSome(cleanup) && Exit.isFailure(cleanup.value)
								? cleanup.value.cause
								: Cause.empty,
						),
					)
				}
				const admitted = admission.value
				if (admitted._tag === "Duplicate") {
					yield* preparation.close.pipe(
						Effect.annotateLogs({ change: admitted.handle.id }),
					)
					return admitted.handle
				}
				yield* TxRef.set<{
					readonly attempt: number | undefined
					readonly phase: Change.Phase
				}>(run.progress, {
					attempt: admitted.attempt,
					phase: "Admission",
				})
				const policy = deadlines(normalized)
				yield* work(
					admitted.managed,
					policy,
					admitted.run,
					admitted.record,
				).pipe(
					Effect.annotateLogs({
						change: admitted.record.handle.id,
						instance: admitted.managed.instance,
						...admitted.run.trace,
					}),
					Effect.provideContext(admitted.managed.context),
					Effect.forkIn(runtime.changes.scope, { uninterruptible: true }),
				)
				return admitted.record.handle
			}),
		request.key,
	)
})
