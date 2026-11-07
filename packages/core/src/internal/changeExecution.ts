import { Array, Cause, Effect, Exit, Option, TxRef } from "effect"

import * as Change from "../Change"
import * as Admission from "./admission"
import * as ChangeTable from "./changeTable"
import {
	confirmed,
	engine,
	ExecutionOutcome,
	failed,
	unconfirmedAllocations,
	type Attempt,
	type Failed,
	type Managed,
	type Run,
} from "./transition"
import { derive, type Deadlines } from "./transitionBudgets"
import * as Trust from "./trust"

const settlement = (result: AwaitedRetirement): Effect.Effect<void, Failed> => {
	if (!confirmed(result))
		return Effect.fail(
			failed({ reason: "UnconfirmedTermination", phase: "Terminating" }),
		)
	if (result.host._tag !== "Completed")
		return Effect.fail(
			failed({ reason: "UnresolvedCleanup", phase: "Terminating" }),
		)
	if (Exit.isSuccess(result.host.exit)) return Effect.void
	return Effect.fail(
		failed({
			reason: Cause.hasInterruptsOnly(result.host.exit.cause)
				? "UnresolvedCleanup"
				: "Failed",
			phase: "Terminating",
		}),
	)
}
type Engine = ReturnType<typeof engine>
type AwaitedRetirement = Effect.Success<ReturnType<Engine["retire"]>>
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

const prepareCandidate = Effect.fnUntraced(function* (
	coordinator: Engine,
	run: Run,
	desired: Change.Candidate,
): Effect.fn.Return<Attempt, Failed> {
	const attempt = yield* coordinator.allocate(desired)
	yield* TxRef.set(run.candidate, Option.some(attempt))
	yield* coordinator.start(attempt)
	return attempt
})
const observeTrial = (
	coordinator: Engine,
	policy: Deadlines,
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
const retirePrevious = Effect.fnUntraced(function* (
	coordinator: Engine,
	previous: Option.Option<Attempt>,
): Effect.fn.Return<void, Failed> {
	if (Option.isNone(previous)) return
	const result = yield* coordinator.retire(previous.value)
	yield* settlement(result)
})
const settleCandidate = Effect.fnUntraced(function* (
	managed: Managed,
	coordinator: Engine,
	run: Run,
): Effect.fn.Return<void, Failed> {
	const candidate = yield* TxRef.get(run.candidate)
	if (Option.isSome(candidate)) {
		const result = yield* coordinator.terminate(candidate.value)
		yield* settlement(result)
		yield* TxRef.set(run.candidate, Option.none())
	}
	if (yield* unconfirmedAllocations(managed))
		return yield* Effect.fail(
			failed({ reason: "UnconfirmedTermination", phase: "Starting" }),
		)
})
const recover = Effect.fnUntraced(function* (
	coordinator: Engine,
	policy: Deadlines,
	run: Run,
): Effect.fn.Return<void, Failed> {
	yield* retirePrevious(coordinator, run.previous)
	yield* TxRef.set(run.budget.reserved, derive(policy).cleanup)
	const restored = yield* coordinator.allocate(run.previousDesired, true)
	yield* TxRef.set(run.candidate, Option.some(restored))
	const record = run.record
	if (record === undefined)
		return yield* Effect.die(
			new Error("Recovery requires an admitted Change record"),
		)
	yield* Effect.raceFirst(
		Effect.gen(function* () {
			yield* coordinator.start(restored)
			yield* coordinator.cutover(restored)
			yield* observeTrial(coordinator, policy, restored)
		}),
		waitInvalidation(record, run),
	)
})

/** Strategies compose the same owned primitives; only their order differs. */
export const execute = Effect.fnUntraced(function* (
	managed: Managed,
	policy: Deadlines,
	run: Run,
): Effect.fn.Return<ExecutionOutcome> {
	const record = run.record
	if (record === undefined)
		return yield* Effect.die(
			new Error("Admitted execution requires a Change record"),
		)
	const limits = derive(policy)
	const coordinator = engine(
		managed,
		policy,
		run.evidence,
		run.budget,
		run.progress,
		record,
	)
	const strategy = (yield* TxRef.get(record.status)).strategy
	const previous = run.previous
	const complete = (
		tag: ExecutionOutcome["_tag"],
		phase: Change.Phase,
		reason: Change.Reason,
	): Effect.Effect<ExecutionOutcome> =>
		TxRef.get(run.evidence).pipe(
			Effect.map((evidence) => {
				switch (tag) {
					case "Accepted":
						return ExecutionOutcome.Accepted({ phase, evidence })
					case "Aborted":
						return ExecutionOutcome.Aborted({ phase, reason, evidence })
					case "Recovered":
						return ExecutionOutcome.Recovered({ phase, reason, evidence })
					case "RecoveryFailed":
						return ExecutionOutcome.RecoveryFailed({ phase, reason, evidence })
					case "Stuck":
						return ExecutionOutcome.Stuck({
							phase,
							reason:
								reason === "UnresolvedCleanup"
									? reason
									: "UnconfirmedTermination",
							evidence,
						})
				}
			}),
		)
	const healthyOld = Effect.fnUntraced(function* () {
		if (Option.isNone(previous)) return false
		const observed = yield* Effect.result(
			coordinator.step(
				previous.value.id,
				"Readiness",
				Trust.admission(
					managed.runtime,
					managed.instance,
					previous.value.desired.identity,
				).pipe(
					Effect.tx,
					Effect.andThen(
						Effect.asVoid(Effect.timeoutOption(previous.value.failure, 0)),
					),
				),
				policy.startup,
			),
		)
		return observed._tag === "Success"
	})
	const forward = Effect.gen(function* () {
		if (strategy === "Restart") {
			yield* Effect.tx(Admission.pause(managed))
			yield* TxRef.set(run.budget.reserved, limits.recovery + limits.cleanup)
			yield* retirePrevious(coordinator, previous)
			yield* coordinator.setRoute(Option.none())
		}
		const next = yield* prepareCandidate(
			coordinator,
			run,
			record.request.candidate,
		)
		yield* coordinator.cutover(next)
		yield* observeTrial(coordinator, policy, next)
		if (strategy === "Overlap") {
			yield* TxRef.set(run.budget.reserved, limits.recovery + limits.cleanup)
			yield* retirePrevious(coordinator, previous)
		}
		yield* coordinator.step(
			next.id,
			"Trial",
			Effect.asVoid(Effect.timeoutOption(next.failure, 0)),
			policy.startup,
		)
		return yield* complete("Accepted", "Complete", "Failed")
	})
	const stop = Effect.fnUntraced(function* (failure: Failed) {
		yield* Effect.tx(Admission.pause(managed))
		yield* TxRef.set(run.budget.reserved, limits.recovery)
		const cleanup = yield* Effect.result(
			settleCandidate(managed, coordinator, run),
		)
		if (
			cleanup._tag === "Failure" &&
			(cleanup.failure.reason === "UnconfirmedTermination" ||
				cleanup.failure.reason === "UnresolvedCleanup")
		) {
			yield* coordinator.setRoute(Option.none())
			yield* Admission.close(managed, "RecoveryFailed")
			return yield* complete("Stuck", failure.phase, cleanup.failure.reason)
		}
		if (yield* closing(managed)) {
			yield* TxRef.set(run.budget.reserved, 0)
			const stopped = yield* Effect.result(
				retirePrevious(coordinator, previous),
			)
			yield* coordinator.setRoute(Option.none())
			yield* Admission.close(managed, "Closing")
			return yield* complete(
				stopped._tag === "Failure" &&
					(stopped.failure.reason === "UnconfirmedTermination" ||
						stopped.failure.reason === "UnresolvedCleanup")
					? "Stuck"
					: "RecoveryFailed",
				failure.phase,
				stopped._tag === "Failure"
					? stopped.failure.reason
					: failure.reason === "CoordinatorDefect"
						? failure.reason
						: "Closing",
			)
		}
		if (failure.reason === "UnconfirmedTermination") {
			yield* coordinator.setRoute(Option.none())
			yield* Admission.close(managed, "RecoveryFailed")
			return yield* complete("Stuck", failure.phase, failure.reason)
		}
		if (failure.reason === "UnresolvedCleanup") {
			if (yield* TxRef.get(record.oldChanged)) {
				yield* coordinator.setRoute(Option.none())
				yield* Admission.close(managed, "RecoveryFailed")
			} else yield* Admission.open(managed)
			return yield* complete("Stuck", failure.phase, failure.reason)
		}
		if (!(yield* TxRef.get(record.oldChanged)) && (yield* healthyOld())) {
			yield* Admission.open(managed)
			return yield* complete("Aborted", failure.phase, failure.reason)
		}
		yield* coordinator.setRoute(Option.none())

		const recovered = yield* Effect.result(
			Effect.interruptible(
				Effect.raceFirst(
					recover(coordinator, policy, run),
					waitClosing(managed, run),
				),
			),
		)
		if (recovered._tag === "Success")
			return yield* complete("Recovered", "Recovery", failure.reason)
		const recoveryProgress = yield* TxRef.get(run.progress)
		yield* TxRef.update(
			run.evidence,
			Array.append<Change.Evidence>({
				...recoveryProgress,
				phase: "Recovery",
				cause: Cause.fail(recovered.failure),
			}),
		)
		yield* TxRef.set(run.budget.reserved, 0)
		const ended = yield* Effect.result(
			settleCandidate(managed, coordinator, run),
		)
		yield* coordinator.setRoute(Option.none())
		yield* Admission.close(
			managed,
			(yield* closing(managed)) ? "Closing" : "RecoveryFailed",
		)
		return yield* complete(
			ended._tag === "Failure" &&
				(ended.failure.reason === "UnconfirmedTermination" ||
					ended.failure.reason === "UnresolvedCleanup")
				? "Stuck"
				: "RecoveryFailed",
			"Recovery",
			ended._tag === "Failure"
				? ended.failure.reason
				: recovered.failure.reason,
		)
	})
	if (yield* closing(managed))
		return yield* stop(
			failed({
				reason: "Closing",
				phase: (yield* TxRef.get(run.progress)).phase,
			}),
		)
	if (yield* TxRef.get(run.cancel))
		return yield* stop(
			failed({
				reason: "Cancelled",
				phase: (yield* TxRef.get(run.progress)).phase,
			}),
		)
	const result = yield* Effect.exit(
		Effect.interruptible(
			Effect.raceFirst(
				forward,
				Effect.raceFirst(waitCancel(run), waitInvalidation(record, run)),
			),
		),
	)
	if (Exit.isSuccess(result)) return result.value
	const progress = yield* TxRef.get(run.progress)
	yield* TxRef.update(
		run.evidence,
		Array.append({ ...progress, cause: result.cause }),
	)
	const typed = Array.findFirst(
		result.cause.reasons,
		(reason) => reason._tag === "Fail",
	)
	const failure = Option.isSome(typed)
		? typed.value.error
		: failed({ reason: "CoordinatorDefect", phase: progress.phase })
	return yield* stop(failure)
})

/** Defects during settlement still produce an observable, conservative conclusion. */
export const emergency = Effect.fnUntraced(function* (
	managed: Managed,
	policy: Deadlines,
	run: Run,
	cause: Cause.Cause<never>,
) {
	const coordinator = engine(
		managed,
		policy,
		run.evidence,
		run.budget,
		run.progress,
		run.record,
	)
	const progress = yield* TxRef.get(run.progress)
	yield* TxRef.update(run.evidence, Array.append({ ...progress, cause }))
	yield* Effect.tx(
		Admission.close(managed, "RecoveryFailed").pipe(
			Effect.andThen(coordinator.setRoute(Option.none())),
		),
	)
	yield* TxRef.set(run.budget.reserved, 0)
	const attempts = yield* TxRef.get(managed.attempts)
	const results = yield* Effect.forEach(attempts, (attempt) =>
		coordinator.terminate(attempt).pipe(
			Effect.tapCause((cause) =>
				TxRef.update(
					run.evidence,
					Array.append({
						attempt: attempt.id,
						phase: "Terminating",
						cause,
					} satisfies Change.Evidence),
				),
			),
			Effect.exit,
		),
	)
	const evidence = yield* TxRef.get(run.evidence)
	const unconfirmed =
		(yield* unconfirmedAllocations(managed)) ||
		Array.some(
			results,
			(exit) => Exit.isFailure(exit) || !confirmed(exit.value),
		)
	const unresolved = Array.some(
		results,
		(exit) =>
			Exit.isSuccess(exit) &&
			(exit.value.host._tag !== "Completed" ||
				(Exit.isFailure(exit.value.host.exit) &&
					Cause.hasInterruptsOnly(exit.value.host.exit.cause))),
	)
	if (unconfirmed || unresolved)
		return ExecutionOutcome.Stuck({
			phase: progress.phase,
			reason: unconfirmed ? "UnconfirmedTermination" : "UnresolvedCleanup",
			evidence,
		})
	return ExecutionOutcome.RecoveryFailed({
		phase: progress.phase,
		reason: "CoordinatorDefect",
		evidence,
	})
})
