import {
	Array,
	Cause,
	Clock,
	Context,
	Data,
	Effect,
	Equal,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Option,
	Order,
	Ref,
	Scope,
	String,
	TxPubSub,
	TxRef,
	TxSubscriptionRef,
} from "effect"

import * as Change from "../Change"
import * as Plugin from "../Plugin"
import * as Release from "../Release"
import * as T from "../Transition"
import { withdraw } from "./activation"
import * as Admission from "./admission"
import * as AsyncClose from "./asyncClose"
import * as Capacity from "./capacity"
import { deadlines, millis, normalize } from "./changeRequest"
import * as Settlement from "./changeSettlement"
import * as ChangeTable from "./changeTable"
import { captureEdges, resolutionChanged } from "./dependencies"
import * as Generations from "./generations"
import * as OwnedExecution from "./ownedExecution"
import {
	type Activation,
	type ActiveResolution,
	type ForkEntry,
	type Provision,
	type Runtime,
} from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import * as Snapshots from "./snapshot"
import { derive, type Deadlines } from "./transitionBudgets"
import * as Trust from "./trust"

interface ExecutionResult {
	readonly phase: Change.Phase
	readonly evidence: ReadonlyArray<Change.Evidence>
}
export type ExecutionOutcome = Data.TaggedEnum<{
	Accepted: ExecutionResult
	Aborted: ExecutionResult & { readonly reason: Change.Reason }
	Recovered: ExecutionResult & { readonly reason: Change.Reason }
	RecoveryFailed: ExecutionResult & { readonly reason: Change.Reason }
	Stuck: ExecutionResult & {
		readonly reason: "UnconfirmedTermination" | "UnresolvedCleanup"
	}
}>
export const ExecutionOutcome = Data.taggedEnum<ExecutionOutcome>()

type HostRelease = AsyncClose.State

interface Allocated {
	readonly candidate: Change.Candidate
	readonly unit: T.Unit
}
export interface HostLease extends Capacity.Credit {
	readonly allocation: T.Allocation
	readonly executor: OwnedExecution.Execution<Allocated, T.DriverError>
	readonly generation: Generations.Token
	readonly id: number
	readonly scope: Scope.Closeable
	readonly hostRelease: AsyncClose.Close
	readonly terminated: TxRef.TxRef<Option.Option<Change.Termination>>
}
export interface Attempt extends HostLease {
	readonly allocation: T.Allocation
	readonly desired: Change.Candidate
	readonly candidate: Change.Candidate
	readonly unit: T.Unit
	readonly failure: Effect.Effect<never, T.DriverError>
	readonly calls: TxRef.TxRef<number>
	readonly services: TxRef.TxRef<Context.Context<never>>
}
export interface Managed {
	readonly runtime: Runtime
	readonly resolution: ActiveResolution
	readonly initialCredit: Capacity.Credit
	readonly pending: TxRef.TxRef<HashSet.HashSet<Change.Id>>
	readonly instance: string
	readonly driver: T.Driver
	readonly resolve: (
		desired: Change.Candidate,
	) => Effect.Effect<Change.Candidate, T.DriverError>
	readonly desired: TxRef.TxRef<Change.Candidate>
	readonly facades: ReadonlyArray<T.Facade>
	readonly required: ReadonlyArray<Plugin.OperationIdentity>
	readonly policy: Deadlines
	readonly maxInFlight: number
	readonly admission: TxRef.TxRef<Admission.Gate>
	readonly queue: { readonly maxWaiters: number; readonly maxWait: number }
	readonly scope: Scope.Closeable
	readonly lifecycle: TxRef.TxRef<Lifecycle>
	readonly hostFailures: TxRef.TxRef<Cause.Cause<unknown>>
	readonly route: TxRef.TxRef<Option.Option<Attempt>>
	readonly attempts: TxRef.TxRef<ReadonlyArray<Attempt>>
	readonly leases: TxRef.TxRef<ReadonlyArray<HostLease>>
	readonly next: TxRef.TxRef<number>
	readonly context: Context.Context<never>
	readonly entry: ForkEntry
}

const registrationSettled = Effect.fnUntraced(function* (managed: Managed) {
	const lifecycle = yield* TxRef.get(managed.lifecycle)
	const leases = yield* TxRef.get(managed.leases)
	const pending = yield* TxRef.get(managed.pending)
	return (
		lifecycle._tag === "Closed" &&
		leases.length === 0 &&
		HashSet.size(pending) === 0
	)
})
const releaseRegistration = Effect.fnUntraced(function* (managed: Managed) {
	if (!(yield* registrationSettled(managed))) return
	const instances = yield* TxRef.get(managed.runtime.instances)
	if (
		Option.exists(
			HashMap.get(instances, managed.instance),
			(current) => current === managed,
		)
	) {
		yield* TxRef.set(
			managed.runtime.instances,
			HashMap.remove(instances, managed.instance),
		)
	}
})

/** Pending allocation ownership is independent of an Attempt or a coordinator race result. */
export const unconfirmedAllocations = Effect.fnUntraced(function* (
	managed: Managed,
) {
	const leases = yield* TxRef.get(managed.leases)
	const attempts = yield* TxRef.get(managed.attempts)
	const pending = yield* Effect.forEach(
		Array.filter(
			leases,
			(lease) => !Array.some(attempts, (attempt) => attempt.id === lease.id),
		),
		(lease) => TxRef.get(lease.terminated),
	)
	return Array.some(pending, Option.isNone)
}, Effect.tx)

/** Allocation is non-executing, but its own executor must end before NotStarted is evidence. */
export const finishAllocation = Effect.fnUntraced(function* (
	managed: Managed,
	lease: HostLease,
) {
	yield* lease.executor.stop
	const termination: Change.Termination = {
		unit: `${managed.instance}-${lease.id}`,
		state: "NotStarted",
	}
	yield* Effect.tx(
		Effect.gen(function* () {
			yield* TxRef.set(lease.terminated, Option.some(termination))
			yield* Generations.settle(
				managed.runtime,
				managed.entry.node,
				lease.generation,
			)
			yield* Capacity.end(managed.runtime.capacity, lease)
		}),
	)
	return termination
}, Effect.uninterruptible)

export interface Run {
	readonly trace: Change.Trace | undefined
	readonly previous: Option.Option<Attempt>
	readonly previousDesired: Change.Candidate
	readonly candidate: TxRef.TxRef<Option.Option<Attempt>>
	readonly cancel: TxRef.TxRef<boolean>
	readonly record: ChangeTable.Record | undefined
	readonly evidence: TxRef.TxRef<ReadonlyArray<Change.Evidence>>
	readonly progress: TxRef.TxRef<{
		readonly attempt: number | undefined
		readonly phase: Change.Phase
	}>
	readonly budget: Budget
}
type Lifecycle =
	| { readonly _tag: "Initializing" }
	| { readonly _tag: "Open"; readonly active: Option.Option<Run> }
	| { readonly _tag: "Closing"; readonly active: Option.Option<Run> }
	| { readonly _tag: "Closed" }
interface Terminated {
	readonly termination: Option.Option<Change.Termination>
	readonly host: HostRelease
}
export const confirmed = (result: Terminated) =>
	Option.isSome(result.termination)
const foldCauses = <E>(exits: ReadonlyArray<Exit.Exit<unknown, E>>) =>
	Array.reduce(exits, Cause.empty, (cause: Cause.Cause<E>, exit) =>
		Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause,
	)

export const safetyReserve = (policy: Deadlines) => derive(policy).safety
interface Budget {
	readonly started: bigint
	readonly reserved: TxRef.TxRef<number>
}

/** Called in the same transaction as a bypass mutation. */
export const check = Effect.fnUntraced(function* (
	runtime: Runtime,
	id?: number,
) {
	const forks = yield* Snapshots.get(runtime.forks)
	for (const entry of HashMap.values(forks)) {
		const managed = yield* TxRef.get(entry.status.managed)
		if (Option.isNone(managed)) continue
		for (
			let node: ForkEntry | undefined = entry;
			node !== undefined;
			node =
				node.parent === undefined
					? undefined
					: Option.getOrUndefined(HashMap.get(forks, node.parent))
		) {
			if (id === undefined || node.id === id)
				return yield* T.ManagedFork.make({ fork: entry.id })
		}
	}
})
export const assertUnmanaged = Effect.fnUntraced(function* (id?: number) {
	const { runtime } = yield* RuntimeContext
	yield* Effect.tx(check(runtime, id))
})

export const withUnmanaged = Effect.fnUntraced(function* <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	id?: number,
) {
	const { runtime } = yield* RuntimeContext
	return yield* Effect.acquireUseRelease(
		Effect.tx(
			check(runtime, id).pipe(
				Effect.andThen(TxRef.update(runtime.mutations, (n) => n + 1)),
			),
		),
		() => effect,
		() => TxRef.update(runtime.mutations, (n) => n - 1),
	)
})

const generation = (
	managed: Managed,
	attempt: Attempt,
	state: Change.Generation["state"],
) =>
	Effect.tx(
		Effect.gen(function* () {
			const item: Change.Generation = {
				generation: attempt.id,
				attempt: attempt.id,
				candidate: {
					driver: attempt.candidate.driver,
					identity: attempt.candidate.identity,
				},
				state,
			}
			yield* TxSubscriptionRef.update(
				managed.entry.status.generations,
				(all) => {
					const next = [
						...Array.filter(all, (g) => g.attempt !== attempt.id),
						item,
					]
					const retired = Array.filter(next, (g) => g.state === "Terminated")
					const retained = Array.takeRight(
						retired,
						Change.generationHistoryLimit,
					)
					return Array.sort(
						Array.filter(
							next,
							(g) =>
								g.state !== "Terminated" ||
								Array.some(retained, (r) => r.attempt === g.attempt),
						),
						Order.mapInput(Order.Number, (g: Change.Generation) => g.attempt),
					)
				},
			)
			yield* TxPubSub.publish(managed.entry.status.generationEvents, {
				...item,
				candidate: attempt.candidate,
			})
		}),
	)

export interface Failed {
	readonly _tag: "TransitionStepFailed"
	readonly reason: Change.Reason
	readonly phase: Change.Phase
	readonly cause?: Cause.Cause<unknown>
}
export const failed = (value: Omit<Failed, "_tag">): Failed => ({
	_tag: "TransitionStepFailed",
	...value,
})

export const engine = (
	managed: Managed,
	policy: Deadlines,
	evidence: TxRef.TxRef<ReadonlyArray<Change.Evidence>>,
	budget?: Budget,
	progress?: Run["progress"],
	change?: ChangeTable.Record,
) => {
	const limits = derive(policy)
	const record = (item: Change.Evidence) =>
		Effect.tx(
			Effect.gen(function* () {
				yield* TxRef.update(evidence, Array.append(item))
				if (change !== undefined)
					yield* ChangeTable.update(
						managed.runtime.changes,
						change,
						(status) => ({
							...status,
							evidence: Array.append(status.evidence, item),
						}),
					)
			}),
		)
	const observeSettlement = Effect.fnUntraced(function* (lease: HostLease) {
		const lifecycle = yield* TxRef.get(managed.lifecycle)
		const active =
			lifecycle._tag === "Open" || lifecycle._tag === "Closing"
				? lifecycle.active
				: Option.none<Run>()
		const target =
			change ??
			Option.getOrUndefined(
				Option.flatMap(active, (run) => Option.fromUndefinedOr(run.record)),
			)
		if (target === undefined) return
		const fact = yield* Settlement.read(lease)
		yield* Settlement.observe(managed, target, [fact])
	})

	const setRoute = Effect.fnUntraced(function* (
		route: Option.Option<Attempt>,
	): Effect.fn.Return<void> {
		yield* TxRef.set(managed.route, route)
		const lifecycle = yield* TxRef.get(managed.lifecycle)
		const active =
			lifecycle._tag === "Open" || lifecycle._tag === "Closing"
				? lifecycle.active
				: Option.none<Run>()
		const target =
			change ??
			Option.getOrUndefined(
				Option.flatMap(active, (run) => Option.fromUndefinedOr(run.record)),
			)
		if (target !== undefined) yield* Settlement.observe(managed, target, [])
	}, Effect.tx)

	const runOperation = Effect.fnUntraced(function* <A, E>(
		attempt: number,
		phase: Change.Phase,
		effect: Effect.Effect<A, E>,
		remaining: number,
	): Effect.fn.Return<A, Failed> {
		if (remaining <= 0) {
			yield* record({
				attempt,
				phase,
				cause: Cause.die(
					new Error(`Transition total budget exhausted during ${phase}`),
				),
			})
			return yield* Effect.fail(failed({ reason: "TimedOut", phase }))
		}
		// Wait on an owned fiber, not on cancellation of a possibly stuck lifecycle operation.
		const operation = effect.pipe(
			Effect.onExit((exit) =>
				Exit.isFailure(exit)
					? record({ attempt, phase, cause: exit.cause }).pipe(
							Effect.andThen(
								Effect.logError(
									"Execution lifecycle operation failed",
									exit.cause,
								),
							),
						)
					: Effect.void,
			),
		)
		const leases = yield* TxRef.get(managed.leases)
		const lease = Array.findFirst(leases, (lease) => lease.id === attempt)
		const fiber = yield* Option.isSome(lease) && phase !== "Terminating"
			? lease.value.executor.run(operation)
			: Effect.forkIn(operation, managed.scope)
		const result = yield* Effect.timeoutOption(
			Fiber.await(fiber),
			remaining,
		).pipe(
			Effect.onInterrupt(() =>
				Effect.forkIn(Fiber.interrupt(fiber), managed.scope).pipe(
					Effect.asVoid,
				),
			),
		)
		if (Option.isNone(result)) {
			yield* Effect.forkIn(Fiber.interrupt(fiber), managed.scope)
			yield* record({
				attempt,
				phase,
				cause: Cause.die(
					new Error(`Transition deadline expired during ${phase}`),
				),
			})
			return yield* Effect.fail(failed({ reason: "TimedOut", phase: phase }))
		}
		const attempts = yield* TxRef.get(managed.attempts)
		const observedAttempt = Array.findFirst(
			attempts,
			(item) => item.id === attempt,
		)
		if (
			Option.isSome(observedAttempt) &&
			!Equal.equals(
				observedAttempt.value.unit.acknowledgement,
				observedAttempt.value.allocation,
			)
		)
			return yield* Effect.fail(failed({ reason: "Stale", phase }))
		if (Exit.isFailure(result.value)) {
			yield* record({ attempt, phase, cause: result.value.cause })
			return yield* Effect.fail(failed({ reason: "Failed", phase: phase }))
		}
		yield* record({ attempt, phase })
		return result.value.value
	})
	const step = Effect.fnUntraced(function* <A, E>(
		attempt: number,
		phase: Change.Phase,
		effect: Effect.Effect<A, E>,
		limit: number,
	): Effect.fn.Return<A, Failed> {
		if (progress !== undefined) yield* TxRef.set(progress, { attempt, phase })
		if (change !== undefined) {
			const leases = yield* TxRef.get(managed.leases)
			const settlements = yield* Effect.forEach(leases, Settlement.read)
			const elapsed =
				Number((yield* Clock.monotonicTimeNanos) - change.started) / 1_000_000
			yield* Settlement.observe(managed, change, settlements, (status) => ({
				...status,
				phase,
				remaining: Math.max(0, policy.total - elapsed),
				members: Array.map(status.members, (member) => ({
					...member,
					execution: Change.Execution.Running({ phase }),
				})),
			}))
		}
		const remaining =
			budget === undefined
				? limit
				: Math.min(
						limit,
						policy.total -
							Number((yield* Clock.monotonicTimeNanos) - budget.started) /
								1_000_000 -
							(yield* TxRef.get(budget.reserved)),
					)
		return yield* runOperation(attempt, phase, effect, remaining)
	})
	const acquireLease = Effect.fnUntraced(function* (
		desired: Change.Candidate,
		recovery: boolean,
	): Effect.fn.Return<HostLease, Failed> {
		const grant = yield* Effect.tx(
			Effect.gen(function* () {
				if (yield* resolutionChanged(managed.resolution))
					return yield* Effect.fail(
						failed({ reason: "Stale", phase: "Starting" }),
					)
				const term = yield* TxRef.get(managed.next)
				const generation = yield* Generations.acquire(
					managed.runtime,
					managed.entry.node,
					managed.resolution,
				)
				yield* TxRef.set(managed.next, term + 1)
				if (change !== undefined) yield* Capacity.take(change.capacity)
				return { id: term, generation }
			}),
		)
		const { id, generation: tokenGeneration } = grant
		const scope = yield* Scope.make()
		const allocation = yield* beginAllocation(desired, id, scope, recovery)
		const lease: HostLease = {
			...allocation,
			id,
			scope,
			charged:
				change === undefined
					? managed.initialCredit.charged
					: yield* TxRef.make(true),
			capacity: yield* TxRef.make<Option.Option<Capacity.Claim>>(
				change === undefined ? Option.none() : Option.some(change.capacity),
			),
			generation: tokenGeneration,
			hostRelease: yield* AsyncClose.make(
				managed.scope,
				allocation.executor.close,
				(exit) => completeHostRelease(lease, exit),
			),
			terminated: yield* TxRef.make(Option.none<Change.Termination>()),
		}
		yield* TxRef.update(managed.leases, Array.append(lease))

		return lease
	})
	const beginAllocation = Effect.fnUntraced(function* (
		desired: Change.Candidate,
		id: number,
		scope: Scope.Closeable,
		recovery: boolean,
	) {
		const routeVersion = yield* Effect.tx(
			Effect.gen(function* () {
				const cell = yield* ChangeTable.object(managed.runtime.changes, {
					_tag: "Instance",
					instance: managed.instance,
				})
				const current = yield* TxRef.get(cell)
				return current.version + (change === undefined ? 0 : 1)
			}),
		)
		const token: T.Allocation = Object.freeze({
			change:
				change === undefined ? Option.none() : Option.some(change.handle.id),
			generation: id,
			term: id,
			routeVersion,
		})
		const executor = yield* OwnedExecution.start(
			managed.scope,
			scope,
			Effect.gen(function* () {
				if (recovery && change !== undefined) {
					// Recovery metadata owns the scoped binding before authorization is captured.
					if (managed.driver.prepare !== undefined)
						yield* managed.driver.prepare(desired)
					yield* ChangeTable.authorizeRecovery(change, desired.identity).pipe(
						Effect.mapError((cause) => T.DriverError.make({ cause })),
					)
				}
				const candidate = yield* Effect.suspend(() => managed.resolve(desired))
				if (
					candidate.driver !== desired.driver ||
					candidate.identity !== desired.identity ||
					(managed.driver.footprint !== undefined &&
						!Equal.equals(
							managed.driver.footprint(desired),
							managed.driver.footprint(candidate),
						))
				)
					return yield* T.DriverError.make({
						cause: Cause.fail(
							"Resolved input changed the admitted resource footprint",
						),
					})
				const unit = yield* Effect.suspend(() =>
					managed.driver.allocate(candidate, id, token),
				)
				return { candidate, unit }
			}),
			(exit) =>
				Exit.isFailure(exit)
					? record({ attempt: id, phase: "Starting", cause: exit.cause }).pipe(
							Effect.andThen(
								Effect.logError("Execution allocation failed", exit.cause),
							),
						)
					: Effect.void,
		)
		return { allocation: token, executor }
	})
	const allocateUnit = Effect.fnUntraced(function* (
		desired: Change.Candidate,
		lease: HostLease,
	): Effect.fn.Return<Attempt, Failed> {
		const { id, allocation: token } = lease
		const allocation = yield* step(
			id,
			"Starting",
			Fiber.join(lease.executor.fiber),
			limits.startup.allocate,
		)
		const { candidate, unit } = allocation
		if (!Equal.equals(unit.acknowledgement, token))
			return yield* Effect.fail(failed({ reason: "Stale", phase: "Starting" }))
		const attempt: Attempt = {
			...lease,
			allocation: token,
			desired,
			candidate,
			unit,
			failure: Effect.raceFirst(
				Effect.suspend(() => unit.failure),
				Effect.suspend(() => unit.exited).pipe(
					Effect.flatMap((termination) =>
						T.DriverError.make({
							cause: termination.cause ?? Cause.fail(termination),
						}),
					),
				),
			),
			calls: yield* TxRef.make(0),
			services: yield* TxRef.make(Context.empty()),
		}
		yield* TxRef.update(managed.attempts, Array.append(attempt))
		yield* generation(managed, attempt, "Starting")
		yield* observeExit(attempt).pipe(Effect.forkIn(managed.scope))
		return attempt
	})
	const failAllocation = Effect.fnUntraced(function* (
		lease: HostLease,
		cause: Cause.Cause<Failed>,
	): Effect.fn.Return<never, Failed> {
		const { id } = lease
		yield* record({ attempt: id, phase: "Starting", cause })
		const cleanup = yield* finishAllocation(managed, lease).pipe(
			Effect.andThen(beginHostRelease(lease)),
			Effect.forkIn(managed.runtime.changes.cleanupScope, {
				uninterruptible: true,
			}),
		)
		const ended = yield* Effect.timeoutOption(
			Fiber.await(cleanup),
			limits.termination.exit,
		)
		if (Option.isNone(ended))
			return yield* Effect.fail(
				failed({ reason: "UnconfirmedTermination", phase: "Starting" }),
			)
		if (Exit.isFailure(ended.value)) {
			yield* record({
				attempt: id,
				phase: "Starting",
				cause: ended.value.cause,
			})
			return yield* Effect.fail(
				failed({ reason: "UnresolvedCleanup", phase: "Starting" }),
			)
		}
		const termination = yield* TxRef.get(lease.terminated)
		if (Option.isSome(termination))
			yield* record({
				attempt: id,
				phase: "Starting",
				termination: termination.value,
			})
		const host = yield* awaitHostRelease(lease)
		if (
			host._tag !== "Completed" ||
			(Exit.isFailure(host.exit) && Cause.hasInterruptsOnly(host.exit.cause))
		)
			return yield* Effect.fail(
				failed({ reason: "UnresolvedCleanup", phase: "Starting" }),
			)
		return yield* Effect.failCause(cause)
	})

	const allocate = (
		desired: Change.Candidate,
		recovery = false,
	): Effect.Effect<Attempt, Failed> =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const lease = yield* acquireLease(desired, recovery)
				const allocated = yield* Effect.exit(
					restore(allocateUnit(desired, lease)),
				)
				return Exit.isSuccess(allocated)
					? allocated.value
					: yield* failAllocation(lease, allocated.cause)
			}),
		)

	const start = Effect.fnUntraced(function* (attempt: Attempt) {
		const { unit, id } = attempt
		yield* step(
			id,
			"Starting",
			Trust.admission(
				managed.runtime,
				managed.instance,
				attempt.desired.identity,
			).pipe(Effect.tx),
			policy.startup,
		)
		yield* step(
			id,
			"Starting",
			Effect.raceFirst(
				Effect.suspend(() => Scope.provide(unit.start, attempt.scope)),
				attempt.failure,
			),
			limits.startup.start,
		)
		const description = yield* step(
			id,
			"Describing",
			Effect.raceFirst(
				Effect.suspend(() => unit.describe),
				attempt.failure,
			),
			limits.startup.describe,
		)
		if (
			change !== undefined &&
			(yield* TxRef.get(change.status)).strategy === "Overlap" &&
			!description.overlap
		)
			return yield* Effect.fail(
				failed({ reason: "IncompatibleContract", phase: "Describing" }),
			)
		const comparison = Plugin.compareOperations(
			managed.required,
			description.provides,
		)
		if (comparison._tag === "Incompatible") {
			yield* record({
				attempt: id,
				phase: "Describing",
				cause: Cause.fail(comparison),
			})
			return yield* Effect.fail(
				failed({ reason: "IncompatibleContract", phase: "Describing" }),
			)
		}
		yield* step(
			id,
			"Serving",
			Effect.raceFirst(
				Effect.suspend(() => unit.serve),
				attempt.failure,
			),
			limits.startup.serve,
		)
		const services = yield* step(
			id,
			"Readiness",
			Effect.raceFirst(
				Effect.suspend(() => unit.ready),
				attempt.failure,
			),
			limits.startup.ready,
		)
		for (const facade of managed.facades) {
			if (
				Option.isNone(
					Context.getOption(services, Context.Service<unknown>(facade.key)),
				)
			) {
				yield* record({
					attempt: id,
					phase: "Readiness",
					cause: Cause.die(
						new Error(`The execution unit did not provide ${facade.key}`),
					),
				})
				return yield* Effect.fail(
					failed({ reason: "IncompatibleContract", phase: "Readiness" }),
				)
			}
		}
		yield* TxRef.set(attempt.services, services)
		for (const name of policy.probes)
			yield* step(
				id,
				"Probing",
				Effect.raceFirst(
					Effect.suspend(() => unit.probe(name)),
					unit.failure,
				),
				policy.probe,
			)
	})
	const completeHostRelease = Effect.fnUntraced(function* (
		lease: HostLease,
		exit: Exit.Exit<void>,
	) {
		if (Exit.isFailure(exit)) {
			yield* TxRef.update(managed.hostFailures, (all) =>
				Cause.combine(all, exit.cause),
			)
			yield* record({
				attempt: lease.id,
				phase: "Terminating",
				cause: exit.cause,
			})
			yield* Effect.logError("Execution host release failed", exit.cause)
		}
		if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause))
			yield* Effect.tx(
				Effect.gen(function* () {
					yield* TxRef.update(
						managed.leases,
						Array.filter((item) => item.id !== lease.id),
					)
					yield* TxRef.update(
						managed.attempts,
						Array.filter((item) => item.id !== lease.id),
					)
					yield* releaseRegistration(managed)
				}),
			)
	})
	const beginHostRelease = (lease: HostLease) =>
		lease.hostRelease.start.pipe(
			Effect.andThen(Ref.get(lease.hostRelease.state)),
		)
	const releaseHost = (lease: HostLease) =>
		lease.hostRelease.start.pipe(Effect.andThen(lease.hostRelease.await))

	const awaitHostRelease = Effect.fnUntraced(function* (attempt: HostLease) {
		const state = yield* beginHostRelease(attempt)
		if (state._tag === "Completed") {
			yield* observeSettlement(attempt)
			if (Exit.isFailure(state.exit))
				yield* record({
					attempt: attempt.id,
					phase: "Terminating",
					cause: state.exit.cause,
				})
			return state
		}
		yield* Effect.exit(
			step(
				attempt.id,
				"Terminating",
				attempt.hostRelease.await,
				limits.termination.hostRelease,
			),
		)
		// The deadline is evidence about this wait, not the finalizer's eventual exit.
		const observed = yield* Ref.get(attempt.hostRelease.state)
		yield* observeSettlement(attempt)
		if (observed._tag === "Completed" && Exit.isFailure(observed.exit))
			yield* record({
				attempt: attempt.id,
				phase: "Terminating",
				cause: observed.exit.cause,
			})
		return observed
	})
	const recordExit = (attempt: Attempt, termination: Change.Termination) =>
		Effect.tx(
			Effect.gen(function* () {
				const current = yield* TxRef.get(evidence)
				if (
					!Array.some(
						current,
						(item) =>
							item.attempt === attempt.id && item.termination !== undefined,
					)
				)
					yield* record({
						attempt: attempt.id,
						phase: "Terminating",
						termination,
					})
			}),
		)
	const confirmExit = (attempt: Attempt, termination: Change.Termination) =>
		Effect.tx(
			Effect.gen(function* () {
				yield* TxRef.set(attempt.terminated, Option.some(termination))
				yield* Generations.settle(
					managed.runtime,
					managed.entry.node,
					attempt.generation,
				)
				yield* Capacity.end(managed.runtime.capacity, attempt)
				yield* observeSettlement(attempt)
			}),
		)
	const observeExit = Effect.fnUntraced(
		function* (attempt: Attempt) {
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const termination = yield* restore(
						Effect.suspend(() => attempt.unit.exited),
					)
					yield* confirmExit(attempt, termination)
					yield* recordExit(attempt, termination)
					yield* Effect.tx(
						Effect.gen(function* () {
							const route = yield* TxRef.get(managed.route)
							if (Option.contains(route, attempt)) {
								yield* setRoute(Option.none())
								const gate = yield* TxRef.get(managed.admission)
								if (gate._tag !== "Paused")
									yield* Admission.close(managed, "RecoveryFailed")
							}
						}),
					)
					yield* beginHostRelease(attempt)
					yield* generation(managed, attempt, "Terminated")
				}),
			)
		},
		(effect, attempt) =>
			Effect.catchCause(effect, (cause) =>
				record({ attempt: attempt.id, phase: "Terminating", cause }),
			),
	)
	const terminate = Effect.fnUntraced(function* (attempt: Attempt) {
		const known = yield* TxRef.get(attempt.terminated)
		if (Option.isSome(known)) {
			yield* recordExit(attempt, known.value)
			return { termination: known, host: yield* awaitHostRelease(attempt) }
		}
		// A command's acknowledgement is not exit evidence. Observe exit independently.
		const command = yield* attempt.executor.run(
			Effect.suspend(() => attempt.unit.terminate).pipe(
				Effect.tapCause((cause) =>
					Effect.logError("Execution termination command failed", cause),
				),
				Effect.exit,
				Effect.flatMap((exit) =>
					Exit.isFailure(exit)
						? record({
								attempt: attempt.id,
								phase: "Terminating",
								cause: exit.cause,
							})
						: Effect.void,
				),
			),
		)
		const observed = yield* Effect.result(
			step(
				attempt.id,
				"Terminating",
				Effect.suspend(() => attempt.unit.exited),
				limits.termination.exit,
			),
		)
		yield* Effect.forkIn(Fiber.interrupt(command), managed.scope)
		if (observed._tag === "Failure") {
			yield* generation(managed, attempt, "Stuck")
			return {
				termination: Option.none<Change.Termination>(),
				host: yield* Ref.get(attempt.hostRelease.state),
			}
		}
		// Cache exit and register the independent release owner before interruption can resume.
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* recordExit(attempt, observed.success)
				yield* confirmExit(attempt, observed.success)
				yield* beginHostRelease(attempt)
				yield* generation(managed, attempt, "Terminated")
			}),
		)
		const host = yield* awaitHostRelease(attempt)
		return { termination: Option.some(observed.success), host }
	})
	const retire = Effect.fnUntraced(function* (attempt: Attempt) {
		const known = yield* TxRef.get(attempt.terminated)
		if (Option.isSome(known)) return yield* terminate(attempt)
		yield* generation(managed, attempt, "Draining")
		yield* Effect.result(
			step(
				attempt.id,
				"Draining",
				Effect.tx(
					Effect.gen(function* () {
						if ((yield* TxRef.get(attempt.calls)) > 0)
							return yield* Effect.txRetry
					}),
				),
				policy.drain,
			),
		)
		if (change !== undefined) yield* TxRef.set(change.oldChanged, true)
		yield* Effect.result(
			step(
				attempt.id,
				"Stopping",
				Effect.suspend(() => attempt.unit.stop),
				policy.stop,
			),
		)
		return yield* terminate(attempt)
	})
	const cutover = (attempt: Attempt) =>
		Effect.tx(
			Effect.gen(function* () {
				const lifecycle = yield* TxRef.get(managed.lifecycle)
				if (lifecycle._tag === "Closing" || lifecycle._tag === "Closed")
					return yield* Effect.interrupt
				if (change !== undefined && !(yield* ChangeTable.commit(change)))
					return yield* Effect.fail(
						failed({ reason: "Stale", phase: "Cutover" }),
					)
				yield* Trust.admission(
					managed.runtime,
					managed.instance,
					attempt.desired.identity,
				).pipe(
					Effect.mapError((error) =>
						failed({
							reason: "Failed",
							phase: "Cutover",
							cause: Cause.fail(error),
						}),
					),
				)
				if (change !== undefined) yield* TxRef.set(change.oldChanged, true)
				yield* TxRef.set(managed.desired, attempt.desired)
				yield* setRoute(Option.some(attempt))
				yield* Admission.open(managed)
				yield* generation(managed, attempt, "Serving")
			}),
		).pipe(Effect.andThen(record({ attempt: attempt.id, phase: "Cutover" })))
	return {
		allocate,
		start,
		terminate,
		retire,
		cutover,
		step,
		releaseHost,
		setRoute,
	}
}

const admitRegistration = Effect.fnUntraced(function* (
	managed: Managed,
): Effect.fn.Return<void, T.DriverError> {
	const { runtime, entry, instance, resolution } = managed
	if ((yield* TxRef.get(runtime.mutations)) > 0)
		return yield* T.DriverError.make({
			cause: Cause.die(new Error("A bypass mutation is in progress")),
		})
	const spec = yield* TxRef.get(entry.spec)
	const snapshot = yield* Snapshots.get(entry.status.snapshot)
	if (snapshot.accepted !== spec)
		return yield* T.DriverError.make({
			cause: Cause.die(
				new Error("The fork changed before driver registration"),
			),
		})
	const existing = yield* TxRef.get(entry.status.managed)
	if (Option.isSome(existing))
		return yield* T.DriverError.make({
			cause: Cause.die(new Error("The fork already has an execution driver")),
		})
	const registered = yield* TxRef.get(runtime.instances)
	if (HashMap.has(registered, instance))
		return yield* T.DriverError.make({
			cause: Cause.die(
				new Error(`Managed instance already registered: ${instance}`),
			),
		})
	const reservation = yield* ChangeTable.object(runtime.changes, {
		_tag: "Instance",
		instance,
	})
	if (Option.isSome((yield* TxRef.get(reservation)).writer))
		return yield* T.DriverError.make({
			cause: Cause.die(
				new Error(`Managed instance has unresolved settlement: ${instance}`),
			),
		})
	yield* Capacity.initial(runtime.capacity).pipe(
		Effect.mapError((error) =>
			T.DriverError.make({ cause: Cause.fail(error) }),
		),
	)
	yield* TxRef.set(
		runtime.instances,
		HashMap.set(registered, instance, managed),
	)
	yield* ChangeTable.bump(runtime.changes, {
		_tag: "Instance",
		instance,
	})
	yield* TxRef.update(runtime.trust, (state) => ({
		...state,
		used: true,
	}))
	for (const edge of captureEdges(instance, resolution))
		yield* ChangeTable.bump(runtime.changes, edge)
	yield* TxRef.set(entry.status.managed, Option.some(managed))
}, Effect.tx)

const disposeRegistration = Effect.fnUntraced(function* (
	managed: Managed,
	facadeActivation: Activation,
	evidence: TxRef.TxRef<ReadonlyArray<Change.Evidence>>,
	closed: Fiber.Fiber<void>,
): Effect.fn.Return<void> {
	const { runtime, entry, instance, resolution, policy } = managed
	const coordinator = engine(managed, policy, evidence)
	const active = yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(managed.lifecycle)
			const active =
				state._tag === "Open" || state._tag === "Closing"
					? state.active
					: Option.none<Run>()
			yield* Admission.close(managed, "Closing")
			yield* TxRef.set(managed.lifecycle, { _tag: "Closing", active })
			yield* coordinator.setRoute(Option.none())
			return active
		}),
	)
	if (Option.isSome(active)) {
		yield* TxRef.set(active.value.cancel, true)
		yield* waitOutcome(active.value)
	}
	const remaining = yield* TxRef.get(managed.attempts)
	const cleanup = yield* Effect.forEach(remaining, (attempt) =>
		Effect.gen(function* () {
			const coordinator = engine(managed, policy, evidence)
			const result = yield* coordinator.terminate(attempt)
			if (confirmed(result)) return Exit.void

			const observed = yield* TxRef.get(evidence)
			return Exit.failCause(
				Cause.die(
					T.DriverError.make({
						cause: Cause.fail({ evidence: observed }),
					}),
				),
			)
		}),
	)
	const releases = yield* Effect.forEach(
		[withdraw(runtime, facadeActivation)],
		Effect.exit,
	)
	yield* Effect.tx(
		Effect.gen(function* () {
			yield* TxRef.set(managed.lifecycle, { _tag: "Closed" })
			const installed = yield* TxRef.get(entry.status.managed)
			if (Option.contains(installed, managed))
				yield* TxRef.set(entry.status.managed, Option.none())
			yield* releaseRegistration(managed)
			for (const edge of captureEdges(instance, resolution))
				yield* ChangeTable.bump(runtime.changes, edge)
			yield* ChangeTable.bump(runtime.changes, {
				_tag: "Instance",
				instance,
			})
		}),
	)
	if (yield* registrationSettled(managed)) yield* Fiber.join(closed)
	const hostFailures = yield* TxRef.get(managed.hostFailures)
	const cause = Cause.combine(
		foldCauses([...cleanup, ...releases]),
		hostFailures,
	)
	if (cause.reasons.length > 0)
		return yield* Effect.die(T.DriverError.make({ cause }))
})

export const register = Effect.fnUntraced(function* (
	driver: T.Driver,
	registration: T.Registration,
) {
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const { runtime, activation } = yield* RuntimeContext
			const forks = yield* Snapshots.get(runtime.forks)
			const entry = Option.getOrUndefined(HashMap.get(forks, activation.fork))
			if (entry === undefined)
				return yield* T.DriverError.make({
					cause: Cause.die(
						new Error("Execution drivers require a plugin fork"),
					),
				})
			const initialSpec = yield* TxRef.get(entry.spec)
			if (initialSpec.plugin.retry !== undefined)
				return yield* T.DriverError.make({
					cause: Cause.die(
						new Error("Managed drivers do not support automatic retries"),
					),
				})
			const boundInstance = yield* T.CurrentInstance
			const instance =
				Option.getOrUndefined(boundInstance) ?? registration.instance
			if (
				instance === undefined ||
				String.trim(instance) === "" ||
				(Option.isSome(boundInstance) &&
					registration.instance !== undefined &&
					registration.instance !== boundInstance.value)
			)
				return yield* T.DriverError.make({
					cause: Cause.die(
						new Error(
							"Managed instances require an explicit, matching instance name",
						),
					),
				})
			const normalized = yield* normalize({
				instance,
				candidate: registration.initial,
				budget: registration.budget,
				requirements: registration.requirements,
			}).pipe(
				Effect.mapError((error) =>
					T.DriverError.make({ cause: Cause.fail(error) }),
				),
			)
			const policy = deadlines(normalized)
			const maxInFlight = registration.maxInFlight ?? 256
			const maxWaiters = registration.queue?.maxWaiters ?? 256
			const maxWait = millis(registration.queue?.maxWait ?? 5000)
			if (
				!Number.isSafeInteger(maxWaiters) ||
				maxWaiters < 1 ||
				!Number.isFinite(maxWait) ||
				maxWait <= 0 ||
				!Number.isSafeInteger(maxInFlight) ||
				maxInFlight < 1 ||
				driver.name !== registration.initial.driver
			)
				return yield* T.DriverError.make({
					cause: Cause.die(new Error("Invalid execution driver registration")),
				})
			const nodeState = yield* TxRef.get(entry.node.state)
			const resolution = HashMap.getUnsafe(
				nodeState.resolutions,
				activation.generation,
			)
			const registrationScope = yield* Effect.scope
			const managed: Managed = {
				runtime,
				resolution,
				pending: yield* TxRef.make(HashSet.empty<Change.Id>()),
				initialCredit: {
					charged: yield* TxRef.make(true),
					capacity: yield* TxRef.make(Option.none<Capacity.Claim>()),
				},
				instance,
				driver,
				resolve: registration.resolve ?? Effect.succeed,
				desired: yield* TxRef.make(registration.initial),
				required: registration.required,
				facades: registration.facades,
				policy,
				maxInFlight,
				admission: yield* TxRef.make(Admission.initial),
				queue: { maxWaiters, maxWait },
				scope: yield* Scope.fork(runtime.changes.scope),
				lifecycle: yield* TxRef.make<Lifecycle>({ _tag: "Initializing" }),
				hostFailures: yield* TxRef.make<Cause.Cause<unknown>>(Cause.empty),
				route: yield* TxRef.make<Option.Option<Attempt>>(Option.none()),
				attempts: yield* TxRef.make<ReadonlyArray<Attempt>>([]),
				leases: yield* TxRef.make<ReadonlyArray<HostLease>>([]),
				next: yield* Effect.tx(
					Effect.gen(function* () {
						const terms = yield* TxRef.get(runtime.terms)
						const existing = HashMap.get(terms, instance)
						if (Option.isSome(existing)) return existing.value
						const next = TxRef.makeUnsafe(1)
						yield* TxRef.set(runtime.terms, HashMap.set(terms, instance, next))
						return next
					}),
				),
				context: yield* Effect.context<never>(),
				entry,
			}
			yield* admitRegistration(managed).pipe(
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Release.close(managed.scope, exit)
						: Effect.void,
				),
			)
			const evidence = yield* TxRef.make<ReadonlyArray<Change.Evidence>>([])
			const initializationReserve = yield* TxRef.make(derive(policy).cleanup)
			const coordinator = engine(managed, policy, evidence, {
				started: yield* Clock.monotonicTimeNanos,
				reserved: initializationReserve,
			})
			yield* Scope.addFinalizer(
				managed.scope,
				Effect.gen(function* () {
					const leases = yield* TxRef.get(managed.leases)
					const exits = yield* Effect.forEach(leases, (lease) =>
						Effect.exit(lease.hostRelease.dispose),
					)
					const cause = foldCauses(exits)
					if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
				}),
			)
			// The closer belongs to the parent; managed workers never synchronously close their own scope.
			const closed = yield* Effect.tx(
				Effect.gen(function* () {
					if (!(yield* registrationSettled(managed)))
						return yield* Effect.txRetry
					yield* releaseRegistration(managed)
				}),
			).pipe(
				Effect.andThen(Release.close(managed.scope, Exit.void)),
				Effect.forkIn(runtime.changes.scope),
			)
			const facadeActivation: Activation = {
				...activation,
				published: yield* TxRef.make<Option.Option<ReadonlyArray<Provision>>>(
					Option.some([]),
				),
			}
			yield* Scope.addFinalizer(
				registrationScope,
				disposeRegistration(managed, facadeActivation, evidence, closed),
			)
			yield* restore(
				Effect.gen(function* () {
					const initial = yield* coordinator.allocate(registration.initial)
					yield* coordinator.start(initial)
					yield* coordinator.cutover(initial)
					yield* Effect.tx(
						Effect.gen(function* () {
							const lifecycle = yield* TxRef.get(managed.lifecycle)
							if (lifecycle._tag !== "Initializing")
								return yield* Effect.interrupt
							yield* Effect.forEach(
								registration.facades,
								(facade) =>
									facade.publish(Admission.invoke(managed)).pipe(
										Effect.provideService(RuntimeContext, {
											runtime,
											activation: facadeActivation,
										}),
									),
								{ discard: true },
							).pipe(
								Effect.andThen(
									TxRef.set(managed.lifecycle, {
										_tag: "Open",
										active: Option.none(),
									}),
								),
							)
						}),
					)
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.gen(function* () {
							yield* TxRef.set(initializationReserve, 0)
							yield* coordinator.setRoute(Option.none())
							for (const attempt of yield* TxRef.get(managed.attempts)) {
								yield* coordinator.terminate(attempt)
							}
							const leases = yield* TxRef.get(managed.leases)
							if (leases.length === 0)
								yield* Capacity.end(runtime.capacity, managed.initialCredit)
							const observed = yield* TxRef.get(evidence)
							return yield* T.DriverError.make({
								cause: Cause.combine(cause, Cause.fail({ evidence: observed })),
							})
						}),
					),
				),
			)
		}),
	)
})

const waitOutcome = (run: Run): Effect.Effect<Change.Outcome> =>
	run.record === undefined
		? Effect.die(
				new Error("Waiting for completion requires an admitted Change record"),
			)
		: run.record.handle.await
