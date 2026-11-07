import { Array, Cause, Effect, Exit, Option, TxRef } from "effect"

import * as Change from "../Change"
import * as Admission from "./admission"
import * as ChangeTable from "./changeTable"
import * as Terminal from "./terminalSettlement"
import {
	engine,
	ExecutionOutcome,
	failed,
	type Attempt,
	type Failed,
	type Managed,
	type Run,
} from "./transition"
import { derive, type Deadlines } from "./transitionBudgets"
import * as Trust from "./trust"

type Engine = ReturnType<typeof engine>
interface Execution {
	readonly managed: Managed
	readonly policy: Deadlines
	readonly run: Run
	readonly record: ChangeTable.Record
	readonly coordinator: Engine
}
export interface Finalized {
	readonly outcome: ExecutionOutcome
	readonly settlement: Terminal.Snapshot
}
type Resolution = "Accepted" | "Aborted" | "Recovered" | "RecoveryFailed"
const closing = Effect.fnUntraced(function* (managed: Managed) {
	const lifecycle = yield* TxRef.get(managed.lifecycle)
	return (
		lifecycle._tag === "Closing" ||
		lifecycle._tag === "Closed" ||
		!(yield* TxRef.get(managed.runtime.changes.open))
	)
})
const waitClosing = Effect.fnUntraced(function* (managed: Managed, run: Run) {
	if (!(yield* closing(managed))) return yield* Effect.txRetry
	const progress = yield* TxRef.get(run.progress)
	return yield* Effect.fail(
		failed({ reason: "Closing", phase: progress.phase }),
	)
}, Effect.tx)
const waitCancel = Effect.fnUntraced(function* (run: Run) {
	if (!(yield* TxRef.get(run.cancel))) return yield* Effect.txRetry
	const progress = yield* TxRef.get(run.progress)
	return yield* Effect.fail(
		failed({ reason: "Cancelled", phase: progress.phase }),
	)
}, Effect.tx)
const waitInvalidation = Effect.fnUntraced(function* (
	record: ChangeTable.Record,
	run: Run,
) {
	const invalidation = yield* ChangeTable.invalidation(record)
	if (Option.isNone(invalidation)) return yield* Effect.txRetry
	const progress = yield* TxRef.get(run.progress)
	return yield* Effect.fail(
		failed({
			reason: "Stale",
			phase: progress.phase,
			cause: invalidation.value,
		}),
	)
}, Effect.tx)
const requireSettlement = (
	state: Terminal.Classification,
): Effect.Effect<void, Failed> =>
	state._tag === "Settled"
		? Effect.void
		: Effect.fail(
				failed({
					reason: state._tag === "Unresolved" ? state.reason : "Failed",
					phase: "Terminating",
					cause: state.cause,
				}),
			)
const retirePrevious = Effect.fnUntraced(function* ({
	coordinator,
	run,
}: Execution): Effect.fn.Return<void, Failed> {
	if (Option.isNone(run.previous)) return
	const result = yield* coordinator.retire(run.previous.value)
	yield* requireSettlement(Terminal.generation(result.termination, result.host))
})
const settleCandidate = Effect.fnUntraced(function* ({
	coordinator,
	run,
}: Execution): Effect.fn.Return<void, Failed> {
	const candidate = yield* TxRef.get(run.candidate)
	if (Option.isNone(candidate)) return
	const result = yield* coordinator.terminate(candidate.value)
	yield* requireSettlement(Terminal.generation(result.termination, result.host))
	yield* TxRef.set(run.candidate, Option.none())
})
const prepareCandidate = Effect.fnUntraced(function* (
	{ coordinator, run }: Execution,
	desired: Change.Candidate,
): Effect.fn.Return<Attempt, Failed> {
	const attempt = yield* coordinator.allocate(desired)
	yield* TxRef.set(run.candidate, Option.some(attempt))
	yield* coordinator.start(attempt)
	return attempt
})
const observeTrial = (
	{ coordinator, policy }: Execution,
	attempt: Attempt,
): Effect.Effect<void, Failed> =>
	policy.trial === 0
		? Effect.void
		: coordinator.step(
				attempt.id,
				"Trial",
				Effect.asVoid(Effect.timeoutOption(attempt.failure, policy.trial)),
				Number.POSITIVE_INFINITY,
			)

/** One terminal decision reads every original obligation, including retired previous and recovery generations. */
const terminal = Effect.fnUntraced(function* (
	execution: Execution,
	resolution: Resolution,
	phase: Change.Phase,
	reason: Change.Reason,
): Effect.fn.Return<Finalized> {
	const { managed, run, record, policy } = execution
	const generations = yield* Terminal.generations(managed, record)
	const generationState = Terminal.combine(
		Array.map(generations, (obligation) => obligation.state),
	)
	if (generationState._tag !== "Unresolved") {
		yield* record.preparation.close
		yield* Effect.timeoutOption(record.preparation.await, policy.terminate)
	}
	const settlement = yield* Terminal.classify(managed, record)
	yield* Effect.tx(
		Effect.gen(function* () {
			yield* ChangeTable.update(managed.runtime.changes, record, (status) => ({
				...status,
				preparation: settlement.preparation,
			}))
			if (
				settlement.state._tag !== "Settled" &&
				settlement.state.cause.reasons.length > 0
			)
				yield* TxRef.update(
					run.evidence,
					Array.append<Change.Evidence>({
						phase: "Terminating",
						cause: settlement.state.cause,
					}),
				)
		}),
	)

	const evidence = yield* TxRef.get(run.evidence)
	const result = { phase, evidence }
	if (settlement.state._tag === "Unresolved")
		return {
			settlement,
			outcome: ExecutionOutcome.Stuck({
				...result,
				reason: settlement.state.reason,
			}),
		}
	const outcome =
		resolution === "Accepted" && settlement.state._tag === "Failed"
			? ExecutionOutcome.RecoveryFailed({ ...result, reason: "Failed" })
			: resolution === "Accepted"
				? ExecutionOutcome.Accepted(result)
				: resolution === "Aborted"
					? ExecutionOutcome.Aborted({ ...result, reason })
					: resolution === "Recovered"
						? ExecutionOutcome.Recovered({ ...result, reason })
						: ExecutionOutcome.RecoveryFailed({ ...result, reason })
	return { outcome, settlement }
})
const healthyOld = Effect.fnUntraced(function* ({
	managed,
	run,
	coordinator,
	policy,
}: Execution) {
	if (Option.isNone(run.previous)) return false
	const previous = run.previous.value
	const observed = yield* Effect.result(
		coordinator.step(
			previous.id,
			"Readiness",
			Trust.admission(
				managed.runtime,
				managed.instance,
				previous.desired.identity,
			).pipe(
				Effect.tx,
				Effect.andThen(
					Effect.asVoid(Effect.timeoutOption(previous.failure, 0)),
				),
			),
			policy.startup,
		),
	)
	return observed._tag === "Success"
})
const recover = Effect.fnUntraced(function* (
	execution: Execution,
): Effect.fn.Return<void, Failed> {
	const { coordinator, policy, run, record } = execution
	yield* retirePrevious(execution)
	yield* TxRef.set(run.budget.reserved, derive(policy).cleanup)
	const restored = yield* coordinator.allocate(run.previousDesired, true)
	yield* TxRef.set(run.candidate, Option.some(restored))
	yield* Effect.raceFirst(
		Effect.gen(function* () {
			yield* coordinator.start(restored)
			yield* coordinator.cutover(restored)
			yield* observeTrial(execution, restored)
		}),
		waitInvalidation(record, run),
	)
})
const stop = Effect.fnUntraced(function* (
	execution: Execution,
	failure: Failed,
): Effect.fn.Return<Finalized> {
	const { managed, policy, run, record, coordinator } = execution
	yield* Effect.tx(Admission.pause(managed))
	yield* TxRef.set(run.budget.reserved, derive(policy).recovery)
	yield* Effect.result(settleCandidate(execution))
	const generations = yield* Terminal.generations(managed, record)
	const state = Terminal.combine(
		Array.map(
			Array.filter(
				generations,
				(obligation) =>
					(obligation.retiring &&
						(failure.reason === "UnconfirmedTermination" ||
							failure.reason === "UnresolvedCleanup")) ||
					!Option.exists(
						run.previous,
						(previous) => previous.id === obligation.lease.id,
					),
			),
			(obligation) => obligation.state,
		),
	)
	if (state._tag === "Unresolved") {
		yield* coordinator.setRoute(Option.none())
		yield* Admission.close(managed, "RecoveryFailed")
		return yield* terminal(
			execution,
			"RecoveryFailed",
			failure.phase,
			failure.reason,
		)
	}
	if (yield* closing(managed)) {
		yield* TxRef.set(run.budget.reserved, 0)
		yield* Effect.result(retirePrevious(execution))
		yield* coordinator.setRoute(Option.none())
		yield* Admission.close(managed, "Closing")
		return yield* terminal(
			execution,
			"RecoveryFailed",
			failure.phase,
			failure.reason === "CoordinatorDefect" ? failure.reason : "Closing",
		)
	}
	if (
		!(yield* TxRef.get(record.oldChanged)) &&
		(yield* healthyOld(execution))
	) {
		yield* Admission.open(managed)
		return yield* terminal(execution, "Aborted", failure.phase, failure.reason)
	}
	yield* coordinator.setRoute(Option.none())
	const recovered = yield* Effect.result(
		Effect.interruptible(
			Effect.raceFirst(recover(execution), waitClosing(managed, run)),
		),
	)
	if (recovered._tag === "Success")
		return yield* terminal(execution, "Recovered", "Recovery", failure.reason)
	const progress = yield* TxRef.get(run.progress)
	yield* TxRef.update(
		run.evidence,
		Array.append<Change.Evidence>({
			...progress,
			phase: "Recovery",
			cause: Cause.fail(recovered.failure),
		}),
	)
	yield* TxRef.set(run.budget.reserved, 0)
	yield* Effect.result(settleCandidate(execution))
	yield* coordinator.setRoute(Option.none())
	const isClosing = yield* closing(managed)
	yield* Admission.close(managed, isClosing ? "Closing" : "RecoveryFailed")
	return yield* terminal(
		execution,
		"RecoveryFailed",
		"Recovery",
		recovered.failure.reason,
	)
})
const forward = Effect.fnUntraced(function* (
	execution: Execution,
): Effect.fn.Return<Finalized, Failed> {
	const { managed, run, record, coordinator, policy } = execution
	const strategy = (yield* TxRef.get(record.status)).strategy
	if (strategy === "Restart") {
		yield* Effect.tx(Admission.pause(managed))
		yield* TxRef.set(
			run.budget.reserved,
			derive(policy).recovery + derive(policy).cleanup,
		)
		yield* retirePrevious(execution)
		yield* coordinator.setRoute(Option.none())
	}
	const next = yield* prepareCandidate(execution, record.request.candidate)
	yield* coordinator.cutover(next)
	yield* observeTrial(execution, next)
	if (strategy === "Overlap") {
		yield* TxRef.set(
			run.budget.reserved,
			derive(policy).recovery + derive(policy).cleanup,
		)
		yield* retirePrevious(execution)
	}
	yield* coordinator.step(
		next.id,
		"Trial",
		Effect.asVoid(Effect.timeoutOption(next.failure, 0)),
		policy.startup,
	)
	const finalized = yield* terminal(execution, "Accepted", "Complete", "Failed")
	if (finalized.settlement.state._tag === "Failed")
		return yield* Effect.fail(
			failed({
				reason: "Failed",
				phase: "Terminating",
				cause: finalized.settlement.state.cause,
			}),
		)
	return finalized
})
const context = (
	managed: Managed,
	policy: Deadlines,
	run: Run,
	record: ChangeTable.Record,
): Execution => ({
	managed,
	policy,
	run,
	record,
	coordinator: engine(
		managed,
		policy,
		run.evidence,
		run.budget,
		run.progress,
		record,
	),
})

/** Strategies compose owned operations; the terminal classifier alone chooses Stuck. */
export const execute = Effect.fnUntraced(function* (
	managed: Managed,
	policy: Deadlines,
	run: Run,
): Effect.fn.Return<Finalized> {
	const record = run.record
	if (record === undefined)
		return yield* Effect.die(
			new Error("Admitted execution requires a Change record"),
		)
	const execution = context(managed, policy, run, record)
	const isClosing = yield* closing(managed)
	if (isClosing || (yield* TxRef.get(run.cancel))) {
		const progress = yield* TxRef.get(run.progress)
		return yield* stop(
			execution,
			failed({
				reason: isClosing ? "Closing" : "Cancelled",
				phase: progress.phase,
			}),
		)
	}
	const result = yield* Effect.exit(
		Effect.interruptible(
			Effect.raceFirst(
				forward(execution),
				Effect.raceFirst(waitCancel(run), waitInvalidation(record, run)),
			),
		),
	)
	if (Exit.isSuccess(result)) return result.value
	const progress = yield* TxRef.get(run.progress)
	yield* TxRef.update(
		run.evidence,
		Array.append<Change.Evidence>({ ...progress, cause: result.cause }),
	)
	const typed = Array.findFirst(result.cause.reasons, Cause.isFailReason)
	const failure = Option.isSome(typed)
		? typed.value.error
		: failed({ reason: "CoordinatorDefect", phase: progress.phase })
	return yield* stop(execution, failure)
})

/** Emergency settlement uses the same obligation registry and terminal decision. */
export const emergency = Effect.fnUntraced(function* (
	managed: Managed,
	policy: Deadlines,
	run: Run,
	cause: Cause.Cause<never>,
): Effect.fn.Return<Finalized> {
	const record = run.record
	if (record === undefined)
		return yield* Effect.die(
			new Error("Emergency settlement requires a Change record"),
		)
	const execution = context(managed, policy, run, record)
	const progress = yield* TxRef.get(run.progress)
	yield* TxRef.update(
		run.evidence,
		Array.append<Change.Evidence>({ ...progress, cause }),
	)
	yield* execution.coordinator.setRoute(Option.none())
	yield* Admission.close(managed, "RecoveryFailed")
	yield* TxRef.set(run.budget.reserved, 0)
	const obligations = yield* TxRef.get(record.obligations)
	yield* Effect.forEach(obligations, (lease) =>
		Effect.gen(function* () {
			const attempt = yield* TxRef.get(lease.allocated)
			if (Option.isSome(attempt))
				yield* execution.coordinator.terminate(attempt.value)
		}).pipe(
			Effect.catchCause((cause) =>
				TxRef.update(
					run.evidence,
					Array.append<Change.Evidence>({ phase: "Terminating", cause }),
				),
			),
		),
	)
	return yield* terminal(
		execution,
		"RecoveryFailed",
		progress.phase,
		"CoordinatorDefect",
	)
})
