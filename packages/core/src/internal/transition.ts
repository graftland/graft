import {
	Array,
	Cause,
	Clock,
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Equal,
	Exit,
	Fiber,
	HashMap,
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
import * as Capacity from "./capacity"
import * as ChangeTable from "./changeTable"
import { captureEdges, resolutionChanged } from "./dependencies"
import * as Generations from "./generations"
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

type HostRelease =
	| { readonly _tag: "Pending" }
	| {
			readonly _tag: "Running"
			readonly completed: Deferred.Deferred<Exit.Exit<void>>
	  }
	| { readonly _tag: "Completed"; readonly exit: Exit.Exit<void> }

interface HostLease extends Capacity.Credit {
	readonly generation: Generations.Token
	readonly id: number
	readonly scope: Scope.Closeable
	readonly hostRelease: Ref.Ref<HostRelease>
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

const releaseRegistration = Effect.fnUntraced(function* (managed: Managed) {
	const lifecycle = yield* TxRef.get(managed.lifecycle)
	const leases = yield* TxRef.get(managed.leases)
	if (lifecycle._tag !== "Closed" || leases.length !== 0) return
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

export interface Run {
	readonly trace: Change.Trace | undefined
	readonly reply: TxRef.TxRef<Option.Option<ExecutionOutcome>>
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

const millis = (input: Duration.Input): number =>
	typeof input === "number" && !Number.isFinite(input)
		? Number.NaN
		: Option.match(Duration.fromInput(input), {
				onNone: () => Number.NaN,
				onSome: (duration) =>
					Duration.isFinite(duration)
						? Duration.toMillis(duration)
						: Number.NaN,
			})
const policyOf = (
	input?: Partial<Change.Budget & Change.Requirements>,
): Deadlines => {
	const policy = {
		...{ ...Change.defaultBudget, ...Change.defaultRequirements },
		...input,
	}
	return {
		total: millis(policy.total),
		startup: millis(policy.startup),
		probe: millis(policy.probe),
		trial: millis(policy.trial),
		drain: millis(policy.drain),
		stop: millis(policy.stop),
		terminate: millis(policy.terminate),
		probes: policy.probes,
	}
}
export const safetyReserve = (policy: Deadlines) => derive(policy).safety
const valid = (policy: Deadlines) =>
	Array.every(
		[
			policy.total,
			policy.startup,
			policy.probe,
			policy.drain,
			policy.stop,
			policy.terminate,
		],
		(n) => Number.isFinite(n) && n > 0,
	) &&
	Number.isFinite(policy.trial) &&
	policy.trial >= 0 &&
	policy.total > safetyReserve(policy)
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
		if (change === undefined) return
		const termination = yield* TxRef.get(lease.terminated)
		const host = yield* Ref.get(lease.hostRelease)
		const fact: Change.Settlement = {
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
		yield* Effect.tx(
			ChangeTable.update(managed.runtime.changes, change, (status) => ({
				...status,
				settlement: [
					...Array.filter(
						status.settlement,
						(previous) => previous.generation !== lease.id,
					),
					fact,
				],
				leaseHolders: Option.isSome(termination)
					? Array.filter(
							status.leaseHolders,
							(generation) => generation !== lease.id,
						)
					: status.leaseHolders,
				unconfirmedUnits: Option.isSome(termination)
					? Array.filter(
							status.unconfirmedUnits,
							(generation) => generation !== lease.id,
						)
					: status.unconfirmedUnits,
			})),
		)
	})

	const step = <A, E>(
		attempt: number,
		phase: Change.Phase,
		effect: Effect.Effect<A, E>,
		limit: number,
	): Effect.Effect<A, Failed> =>
		Effect.gen(function* () {
			if (progress !== undefined) yield* TxRef.set(progress, { attempt, phase })
			if (change !== undefined) {
				const attempts = yield* TxRef.get(managed.attempts)
				const settlements = yield* Effect.forEach(attempts, (item) =>
					Effect.gen(function* () {
						const termination = yield* TxRef.get(item.terminated)
						const host = yield* Ref.get(item.hostRelease)
						const settlement: Change.Settlement = {
							generation: item.id,
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
							cause:
								host._tag === "Completed" && Exit.isFailure(host.exit)
									? host.exit.cause
									: Option.flatMap(termination, (value) =>
											Option.fromUndefinedOr(value.cause),
										).pipe(Option.getOrElse(() => Cause.empty)),
						}
						return settlement
					}),
				)
				const elapsed =
					Number((yield* Clock.monotonicTimeNanos) - change.started) / 1_000_000
				yield* Effect.tx(
					ChangeTable.update(managed.runtime.changes, change, (status) => ({
						...status,
						phase,
						remaining: Math.max(0, policy.total - elapsed),
						leaseHolders:
							managed.resolution.provisions.length === 0
								? []
								: Array.map(
										Array.filter(
											settlements,
											(fact) => fact.execution === "Unconfirmed",
										),
										(fact) => fact.generation,
									),
						settlement: [
							...Array.filter(
								status.settlement,
								(old) =>
									!Array.some(
										settlements,
										(next) => next.generation === old.generation,
									),
							),
							...settlements,
						],
						unconfirmedUnits: Array.map(
							Array.filter(
								settlements,
								(item) => item.execution === "Unconfirmed",
							),
							(item) => item.generation,
						),
						members: Array.map(status.members, (member) => ({
							...member,
							execution: Change.Execution.Running({ phase }),
						})),
					})),
				)
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
			const fiber = yield* Effect.forkIn(
				effect.pipe(
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
				),
				managed.scope,
			)
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
	const allocate = Effect.fnUntraced(function* (desired: Change.Candidate) {
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
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
				const lease: HostLease = {
					id,
					scope: yield* Scope.make(),
					charged:
						change === undefined
							? managed.initialCredit.charged
							: yield* TxRef.make(true),
					capacity: yield* TxRef.make<Option.Option<Capacity.Claim>>(
						change === undefined ? Option.none() : Option.some(change.capacity),
					),
					generation: tokenGeneration,
					hostRelease: yield* Ref.make<HostRelease>({ _tag: "Pending" }),
					terminated: yield* TxRef.make(Option.none<Change.Termination>()),
				}
				yield* TxRef.update(managed.leases, Array.append(lease))
				const allocated = yield* Effect.exit(
					restore(
						Effect.gen(function* () {
							const routeVersion = yield* Effect.tx(
								Effect.gen(function* () {
									const cell = yield* ChangeTable.object(
										managed.runtime.changes,
										{ _tag: "Instance", instance: managed.instance },
									)
									const current = yield* TxRef.get(cell)
									return current.version + (change === undefined ? 0 : 1)
								}),
							)
							const token: T.Allocation = Object.freeze({
								change:
									change === undefined
										? Option.none()
										: Option.some(change.handle.id),
								generation: id,
								term: id,
								routeVersion,
							})
							const allocation = yield* step(
								id,
								"Starting",
								Scope.provide(
									Effect.gen(function* () {
										const candidate = yield* Effect.suspend(() =>
											managed.resolve(desired),
										)
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
									lease.scope,
								),
								limits.startup.allocate,
							)
							const { candidate, unit } = allocation
							if (!Equal.equals(unit.acknowledgement, token))
								return yield* Effect.fail(
									failed({ reason: "Stale", phase: "Starting" }),
								)
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
						}),
					),
				)
				if (Exit.isSuccess(allocated)) return allocated.value
				yield* TxRef.set(
					lease.terminated,
					Option.some({
						unit: `${managed.instance}-${id}`,
						state: "NotStarted",
					}),
				)
				const host = yield* awaitHostRelease(lease)
				yield* Effect.tx(
					Generations.settle(
						managed.runtime,
						managed.entry.node,
						lease.generation,
					).pipe(Effect.andThen(Capacity.end(managed.runtime.capacity, lease))),
				)
				yield* record({
					attempt: id,
					phase: "Starting",
					termination: {
						unit: `${managed.instance}-${id}`,
						state: "NotStarted",
					},
					cause: allocated.cause,
				})
				if (
					host._tag !== "Completed" ||
					(Exit.isFailure(host.exit) &&
						Cause.hasInterruptsOnly(host.exit.cause))
				)
					return yield* Effect.fail(
						failed({ reason: "UnresolvedCleanup", phase: "Starting" }),
					)
				return yield* Effect.failCause(allocated.cause)
			}),
		)
	})

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
	const beginHostRelease = Effect.fnUntraced(function* (attempt: HostLease) {
		return yield* Effect.uninterruptible(
			Effect.gen(function* () {
				const completed = yield* Deferred.make<Exit.Exit<void>>()
				const claim = yield* Ref.modify(
					attempt.hostRelease,
					(
						state,
					): readonly [
						{
							readonly owner: boolean
							readonly state: Exclude<HostRelease, { readonly _tag: "Pending" }>
						},
						HostRelease,
					] => {
						if (state._tag !== "Pending")
							return [{ owner: false, state }, state]
						const running: HostRelease & { readonly _tag: "Running" } = {
							_tag: "Running",
							completed,
						}
						return [{ owner: true, state: running }, running]
					},
				)
				if (claim.owner)
					yield* Effect.forkIn(
						Effect.gen(function* () {
							const exit = yield* Effect.exit(
								Release.close(attempt.scope, Exit.void),
							)
							if (Exit.isFailure(exit)) {
								yield* TxRef.update(managed.hostFailures, (all) =>
									Cause.combine(all, exit.cause),
								)
								yield* record({
									attempt: attempt.id,
									phase: "Terminating",
									cause: exit.cause,
								})
								yield* Effect.logError(
									"Execution host release failed",
									exit.cause,
								)
							}
							yield* Ref.set(attempt.hostRelease, { _tag: "Completed", exit })
							if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause))
								yield* TxRef.update(
									managed.leases,
									Array.filter((lease) => lease.id !== attempt.id),
								)
							if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause))
								yield* TxRef.update(
									managed.attempts,
									Array.filter((item) => item.id !== attempt.id),
								)
							yield* Effect.tx(releaseRegistration(managed))
							yield* Deferred.succeed(completed, exit)
						}),
						managed.scope,
						{ uninterruptible: true },
					)
				return claim.state
			}),
		)
	})
	const releaseHost = Effect.fnUntraced(function* (attempt: HostLease) {
		const state = yield* beginHostRelease(attempt)
		return state._tag === "Completed"
			? state.exit
			: yield* Deferred.await(state.completed)
	})
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
				Deferred.await(state.completed),
				limits.termination.hostRelease,
			),
		)
		// The deadline is evidence about this wait, not the finalizer's eventual exit.
		const observed = yield* Ref.get(attempt.hostRelease)
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
								yield* TxRef.set(managed.route, Option.none())
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
		const command = yield* Effect.forkIn(
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
			managed.scope,
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
				host: yield* Ref.get(attempt.hostRelease),
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
				yield* TxRef.set(managed.route, Option.some(attempt))
				yield* Admission.open(managed)
				yield* generation(managed, attempt, "Serving")
			}),
		).pipe(Effect.andThen(record({ attempt: attempt.id, phase: "Cutover" })))
	return { allocate, start, terminate, retire, cutover, step, releaseHost }
}

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
			const policy = policyOf({
				...registration.budget,
				...registration.requirements,
			})
			const maxInFlight = registration.maxInFlight ?? 256
			const maxWaiters = registration.queue?.maxWaiters ?? 256
			const maxWait = millis(registration.queue?.maxWait ?? 5000)
			if (
				!valid(policy) ||
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
			yield* Effect.tx(
				Effect.gen(function* () {
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
							cause: Cause.die(
								new Error("The fork already has an execution driver"),
							),
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
								new Error(
									`Managed instance has unresolved settlement: ${instance}`,
								),
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
				}),
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
					const exits = yield* Effect.forEach(leases, coordinator.releaseHost)
					const cause = foldCauses(exits)
					if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
				}),
			)
			const facadeActivation: Activation = {
				...activation,
				published: yield* TxRef.make<Option.Option<ReadonlyArray<Provision>>>(
					Option.some([]),
				),
			}
			yield* Scope.addFinalizer(
				registrationScope,
				Effect.gen(function* () {
					const active = yield* Effect.tx(
						Effect.gen(function* () {
							const state = yield* TxRef.get(managed.lifecycle)
							const active =
								state._tag === "Open" || state._tag === "Closing"
									? state.active
									: Option.none<Run>()
							yield* Admission.close(managed, "Closing")
							yield* TxRef.set(managed.lifecycle, { _tag: "Closing", active })
							yield* TxRef.set(managed.route, Option.none())
							return active
						}),
					)
					if (Option.isSome(active)) {
						yield* TxRef.set(active.value.cancel, true)
						yield* waitReply(active.value)
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
					const hostFailures = yield* TxRef.get(managed.hostFailures)
					const cause = Cause.combine(
						foldCauses([...cleanup, ...releases]),
						hostFailures,
					)
					if (cause.reasons.length > 0)
						return yield* Effect.die(T.DriverError.make({ cause }))
				}),
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
							yield* TxRef.set(managed.route, Option.none())
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

export const waitReply = (run: Run): Effect.Effect<ExecutionOutcome> =>
	Effect.tx(
		TxRef.get(run.reply).pipe(
			Effect.flatMap(
				Option.match({ onNone: () => Effect.txRetry, onSome: Effect.succeed }),
			),
		),
	)
