import {
	Array,
	Cause,
	Effect,
	Equal,
	Exit,
	HashSet,
	Option,
	TxRef,
} from "effect"

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
import {
	engine,
	ExecutionOutcome,
	safetyReserve,
	type Attempt,
	type HostLease,
	type Managed,
	type Run,
} from "./transition"
import type { Deadlines } from "./transitionBudgets"

const facts = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	outcome: ExecutionOutcome,
) {
	const status = yield* TxRef.get(record.status)
	const route = yield* TxRef.get(managed.route)
	const conditions = yield* TxRef.get(record.conditions)
	const instance = Array.findFirst(
		conditions,
		(c) => c.object._tag === "Instance",
	)
	const version = Option.isSome(instance)
		? (yield* TxRef.get(instance.value.cell)).version
		: 0
	return Array.map(status.members, (member): Change.Member => ({
		...member,
		execution: Change.Execution.Completed({
			phase: outcome.phase,
			outcome: outcome._tag,
		}),
		actual: {
			version,
			generation: Option.map(route, (attempt) => attempt.id).pipe(
				Option.getOrUndefined,
			),
			health: Option.isSome(route) ? "Serving" : "Unavailable",
			matchesTarget: Option.exists(route, (attempt) =>
				Equal.equals(attempt.desired, record.request.candidate),
			),
		},
		recoverability: {
			possible: outcome._tag !== "Stuck",
			reason:
				outcome._tag === "Stuck"
					? "Settlement obligations remain unresolved"
					: "Recovery requires fresh resolution and current authorization",
		},
	}))
})
const publicOutcome = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	outcome: ExecutionOutcome,
): Effect.fn.Return<Change.Outcome> {
	const result: Change.Result = {
		change: record.handle.id,
		phase: outcome.phase,
		evidence: outcome.evidence,
		members: yield* facts(managed, record, outcome),
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
	if (Option.isNone(attempt))
		return { unit: `${managed.instance}-${lease.id}`, state: "NotStarted" }
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
	const attempts = yield* TxRef.get(managed.attempts)
	const route = yield* TxRef.get(managed.route)
	const ownedLeases = yield* TxRef.get(managed.leases)
	const leases = Array.filter(
		ownedLeases,
		(lease) => !Option.exists(route, (serving) => serving.id === lease.id),
	)
	const coordinator = engine(managed, policy, run.evidence)
	const results = yield* Effect.forEach(
		leases,
		(lease) =>
			Effect.gen(function* () {
				const attempt = Array.findFirst(
					attempts,
					(attempt) => attempt.id === lease.id,
				)
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
				const exited = yield* Settlement.read(lease)
				yield* lateFact(managed, record, exited)
				const host = yield* coordinator.releaseHost(lease)
				yield* lateFact(managed, record, {
					generation: lease.id,
					execution: termination.state,
					cleanup: Exit.isSuccess(host)
						? "Completed"
						: Cause.hasInterruptsOnly(host.cause)
							? "Unknown"
							: "Failed",
					cause: Cause.combine(
						termination.cause ?? Cause.empty,
						Exit.isFailure(host) ? host.cause : Cause.empty,
					),
				})
				return Exit.isSuccess(host) || !Cause.hasInterruptsOnly(host.cause)
			}).pipe(
				Effect.catchCause((cause) =>
					lateFact(managed, record, {
						generation: lease.id,
						execution: "Unconfirmed",
						cleanup: "Unknown",
						cause,
					}).pipe(Effect.as(false)),
				),
			),
		{ concurrency: 8 },
	)
	if (!Array.every(results, (complete) => complete)) return
	yield* record.preparation.close
	const preparationExit = yield* record.preparation.await
	yield* Effect.tx(
		ChangeTable.update(managed.runtime.changes, record, (status) => ({
			...status,
			preparation: {
				cleanup: Exit.isSuccess(preparationExit)
					? "Completed"
					: Cause.hasInterruptsOnly(preparationExit.cause)
						? "Unknown"
						: "Failed",
				cause: Exit.isFailure(preparationExit)
					? preparationExit.cause
					: Cause.empty,
			},
		})),
	)
	if (Exit.isFailure(preparationExit)) {
		yield* Effect.tx(
			ChangeTable.update(managed.runtime.changes, record, (status) => ({
				...status,
				evidence: [
					...status.evidence,
					{ phase: "Terminating", cause: preparationExit.cause },
				],
			})),
		)
		if (Cause.hasInterruptsOnly(preparationExit.cause)) return
	}
	yield* Effect.tx(
		ChangeTable.release(record).pipe(
			Effect.andThen(ChangeTable.archive(managed.runtime.changes, record)),
			Effect.andThen(
				TxRef.update(managed.pending, HashSet.remove(record.handle.id)),
			),
		),
	)
})
const work = Effect.fnUntraced(function* (
	managed: Managed,
	policy: Deadlines,
	run: Run,
	record: ChangeTable.Record,
) {
	yield* TxRef.set(run.budget.reserved, safetyReserve(policy))
	const executed = yield* execute(managed, policy, run).pipe(
		Effect.catchCause((cause) => emergency(managed, policy, run, cause)),
	)
	const preparationCleanup =
		executed._tag === "Stuck"
			? Option.none<Exit.Exit<void>>()
			: yield* record.preparation.close.pipe(
					Effect.andThen(
						Effect.timeoutOption(record.preparation.await, policy.terminate),
					),
				)
	const outcome =
		executed._tag === "Stuck" ||
		(Option.isSome(preparationCleanup) &&
			Exit.isSuccess(preparationCleanup.value))
			? executed
			: ExecutionOutcome.Stuck({
					phase: executed.phase,
					reason: "UnresolvedCleanup",
					evidence: [
						...executed.evidence,
						{
							phase: "Terminating",
							cause:
								Option.isSome(preparationCleanup) &&
								Exit.isFailure(preparationCleanup.value)
									? preparationCleanup.value.cause
									: Cause.die(
											new Error(
												"Candidate metadata cleanup remains unresolved",
											),
										),
						},
					],
				})
	yield* Effect.tx(
		ChangeTable.update(managed.runtime.changes, record, (status) => ({
			...status,
			preparation: {
				cleanup: Option.isNone(preparationCleanup)
					? "Pending"
					: Exit.isSuccess(preparationCleanup.value)
						? "Completed"
						: Cause.hasInterruptsOnly(preparationCleanup.value.cause)
							? "Unknown"
							: "Failed",
				cause:
					Option.isSome(preparationCleanup) &&
					Exit.isFailure(preparationCleanup.value)
						? preparationCleanup.value.cause
						: Cause.empty,
			},
		})),
	)
	const published = yield* publicOutcome(managed, record, outcome)
	yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(managed.lifecycle)
			if (
				(state._tag === "Open" || state._tag === "Closing") &&
				Option.contains(state.active, run)
			)
				yield* TxRef.set(managed.lifecycle, { ...state, active: Option.none() })
			yield* ChangeTable.finish(managed.runtime.changes, record, published)
			if (published._tag !== "Stuck")
				yield* TxRef.update(managed.pending, HashSet.remove(record.handle.id))
			yield* TxRef.set(run.reply, Option.some(outcome))
		}),
	)
	if (outcome._tag === "Stuck")
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
					yield* preparation.close
					yield* preparation.await.pipe(
						Effect.flatMap((cleanup) =>
							Exit.isFailure(cleanup)
								? Effect.logError(
										"Redundant Change preparation cleanup failed",
										cleanup.cause,
									)
								: Effect.void,
						),
						Effect.annotateLogs({
							change: admitted.handle.id,
							instance: normalized.instance,
						}),
						Effect.forkIn(runtime.changes.scope),
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
