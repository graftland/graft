import {
	Array,
	Cause,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
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

import * as Plugin from "../Plugin"
import * as Release from "../Release"
import * as T from "../Transition"
import { withdraw } from "./activation"
import * as Generations from "./generations"
import type { Activation, ForkEntry, Provision, Runtime } from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import * as Snapshots from "./snapshot"
import { derive, type Deadlines } from "./transitionBudgets"
import * as Trust from "./trust"

type HostRelease =
	| { readonly _tag: "Pending" }
	| {
			readonly _tag: "Running"
			readonly completed: Deferred.Deferred<Exit.Exit<void>>
	  }
	| { readonly _tag: "Completed"; readonly exit: Exit.Exit<void> }

interface HostLease {
	readonly generation: Generations.Token
	readonly id: number
	readonly scope: Scope.Closeable
	readonly hostRelease: Ref.Ref<HostRelease>
}
interface Attempt extends HostLease {
	readonly candidate: T.Candidate
	readonly unit: T.Unit
	readonly failure: Effect.Effect<never, T.DriverError>
	readonly calls: TxRef.TxRef<number>
	readonly services: Ref.Ref<Context.Context<never>>
	readonly terminated: Ref.Ref<Option.Option<T.Termination>>
}
export interface Managed {
	readonly runtime: Runtime
	readonly instance: string
	readonly driver: T.Driver
	readonly facades: ReadonlyArray<T.Facade>
	readonly required: ReadonlyArray<Plugin.OperationIdentity>
	readonly policy: Deadlines
	readonly maxInFlight: number
	readonly scope: Scope.Closeable
	readonly lifecycle: TxRef.TxRef<Lifecycle>
	readonly hostFailures: Ref.Ref<Cause.Cause<unknown>>
	readonly route: TxRef.TxRef<Option.Option<Attempt>>
	readonly attempts: Ref.Ref<ReadonlyArray<Attempt>>
	readonly next: Ref.Ref<number>
	readonly context: Context.Context<never>
	readonly entry: ForkEntry
}

interface Run {
	readonly reply: Deferred.Deferred<T.Outcome>
	readonly cancel: Deferred.Deferred<void>
	readonly evidence: Ref.Ref<ReadonlyArray<T.Evidence>>
	readonly progress: Ref.Ref<{
		readonly attempt: number
		readonly phase: T.Phase
	}>
	readonly budget: Budget
}
type Lifecycle =
	| { readonly _tag: "Initializing" }
	| { readonly _tag: "Open"; readonly active: Option.Option<Run> }
	| { readonly _tag: "Closing"; readonly active: Option.Option<Run> }
	| { readonly _tag: "Closed" }
interface Terminated {
	readonly termination: Option.Option<T.Termination>
	readonly host: HostRelease
}
const confirmed = (result: Terminated) => Option.isSome(result.termination)
const foldCauses = (exits: ReadonlyArray<Exit.Exit<unknown, unknown>>) =>
	Array.reduce(exits, Cause.empty as Cause.Cause<unknown>, (cause, exit) =>
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
const policyOf = (input?: Partial<T.Policy>): Deadlines => {
	const policy = { ...T.defaultPolicy, ...input }
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
const recoveryReserve = (policy: Deadlines) => derive(policy).recovery
const safetyReserve = (policy: Deadlines) => derive(policy).safety
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
	readonly reserved: Ref.Ref<number>
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
	state: T.Generation["state"],
) =>
	Effect.tx(
		Effect.gen(function* () {
			const item: T.Generation = {
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
					const retained = Array.takeRight(retired, T.generationHistoryLimit)
					return Array.sort(
						Array.filter(
							next,
							(g) =>
								g.state !== "Terminated" ||
								Array.some(retained, (r) => r.attempt === g.attempt),
						),
						Order.mapInput(Order.Number, (g: T.Generation) => g.attempt),
					)
				},
			)
			yield* TxPubSub.publish(managed.entry.status.generationEvents, {
				...item,
				candidate: attempt.candidate,
			})
		}),
	)

interface Failed {
	readonly _tag: "TransitionStepFailed"
	readonly reason: T.Reason
	readonly phase: T.Phase
}
const failed = (value: Omit<Failed, "_tag">): Failed => ({
	_tag: "TransitionStepFailed",
	...value,
})

const engine = (
	managed: Managed,
	policy: Deadlines,
	evidence: Ref.Ref<ReadonlyArray<T.Evidence>>,
	budget?: Budget,
	progress?: Run["progress"],
) => {
	const limits = derive(policy)
	const record = (item: T.Evidence) => Ref.update(evidence, Array.append(item))
	const step = <A, E>(
		attempt: number,
		phase: T.Phase,
		effect: Effect.Effect<A, E>,
		limit: number,
	): Effect.Effect<A, Failed> =>
		Effect.gen(function* () {
			if (progress !== undefined) yield* Ref.set(progress, { attempt, phase })
			const remaining =
				budget === undefined
					? limit
					: Math.min(
							limit,
							policy.total -
								Number((yield* Clock.monotonicTimeNanos) - budget.started) /
									1_000_000 -
								(yield* Ref.get(budget.reserved)),
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
							? Effect.logError(
									"Execution lifecycle operation failed",
									exit.cause,
								)
							: Effect.void,
					),
				),
				managed.scope,
			)
			const result = yield* Effect.timeoutOption(Fiber.await(fiber), remaining)
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
			if (Exit.isFailure(result.value)) {
				yield* record({ attempt, phase, cause: result.value.cause })
				return yield* Effect.fail(failed({ reason: "Failed", phase: phase }))
			}
			yield* record({ attempt, phase })
			return result.value.value
		})
	const allocate = (candidate: T.Candidate) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const id = yield* Ref.getAndUpdate(managed.next, (id) => id + 1)
				const scope = yield* Scope.fork(managed.scope)
				const lease: HostLease = {
					generation: yield* Effect.tx(
						Generations.acquire(managed.runtime, managed.entry.node, {
							watch: HashMap.empty(),
							provisions: [],
						}),
					),
					id,
					scope,
					hostRelease: yield* Ref.make<HostRelease>({ _tag: "Pending" }),
				}
				const unit = yield* restore(
					step(
						id,
						"Starting",
						Scope.provide(
							Effect.suspend(() => managed.driver.allocate(candidate, id)),
							scope,
						),
						limits.startup.allocate,
					),
				).pipe(
					Effect.onExit((exit) =>
						Exit.isFailure(exit)
							? awaitHostRelease(lease).pipe(
									Effect.andThen(
										Effect.tx(
											Generations.settle(managed.entry.node, lease.generation),
										),
									),
								)
							: Effect.void,
					),
				)
				const attempt: Attempt = {
					...lease,
					candidate,
					unit,
					failure: Effect.raceFirst(
						unit.failure,
						unit.exited.pipe(
							Effect.flatMap((termination) =>
								T.DriverError.make({
									cause: termination.cause ?? Cause.fail(termination),
								}),
							),
						),
					),
					calls: yield* TxRef.make(0),
					services: yield* Ref.make(Context.empty()),
					terminated: yield* Ref.make<Option.Option<T.Termination>>(
						Option.none(),
					),
				}
				yield* Ref.update(managed.attempts, Array.append(attempt))
				yield* generation(managed, attempt, "Starting")
				return attempt
			}),
		)
	const start = Effect.fnUntraced(function* (attempt: Attempt) {
		const { unit, id } = attempt
		yield* step(
			id,
			"Starting",
			Effect.raceFirst(
				Scope.provide(unit.start, attempt.scope),
				attempt.failure,
			),
			limits.startup.start,
		)
		const description = yield* step(
			id,
			"Describing",
			Effect.raceFirst(unit.describe, attempt.failure),
			limits.startup.describe,
		)
		if (!description.overlap)
			return yield* Effect.fail(
				failed({ reason: "OverlapRequired", phase: "Describing" }),
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
			Effect.raceFirst(unit.serve, attempt.failure),
			limits.startup.serve,
		)
		const services = yield* step(
			id,
			"Readiness",
			Effect.raceFirst(unit.ready, attempt.failure),
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
		yield* Ref.set(attempt.services, services)
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
								yield* Ref.update(managed.hostFailures, (all) =>
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
							yield* Ref.update(
								managed.attempts,
								Array.filter((item) => item.id !== attempt.id),
							)
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
		if (state._tag === "Completed") return state
		const waited = yield* Effect.exit(
			step(
				attempt.id,
				"Terminating",
				Deferred.await(state.completed),
				limits.termination.hostRelease,
			),
		)
		// A deadline ends this observation, not the owned release or its eventual result.
		if (Exit.isFailure(waited))
			yield* Ref.update(managed.hostFailures, (all) =>
				Cause.combine(all, waited.cause),
			)
		return yield* Ref.get(attempt.hostRelease)
	})
	const terminate = Effect.fnUntraced(function* (attempt: Attempt) {
		const known = yield* Ref.get(attempt.terminated)
		if (Option.isSome(known))
			return { termination: known, host: yield* awaitHostRelease(attempt) }
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
				termination: Option.none<T.Termination>(),
				host: yield* Ref.get(attempt.hostRelease),
			}
		}
		// Cache exit and register the independent release owner before interruption can resume.
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* record({
					attempt: attempt.id,
					phase: "Terminating",
					termination: observed.success,
				})
				yield* Ref.set(attempt.terminated, Option.some(observed.success))
				yield* Effect.tx(
					Generations.settle(managed.entry.node, attempt.generation),
				)
				yield* beginHostRelease(attempt)
				yield* generation(managed, attempt, "Terminated")
			}),
		)
		const host = yield* awaitHostRelease(attempt)
		return { termination: Option.some(observed.success), host }
	})
	const retire = Effect.fnUntraced(function* (attempt: Attempt) {
		const known = yield* Ref.get(attempt.terminated)
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
		yield* Effect.result(
			step(attempt.id, "Stopping", attempt.unit.stop, policy.stop),
		)
		return yield* terminate(attempt)
	})
	const cutover = (attempt: Attempt) =>
		Effect.tx(
			Effect.gen(function* () {
				const lifecycle = yield* TxRef.get(managed.lifecycle)
				if (lifecycle._tag === "Closing" || lifecycle._tag === "Closed")
					return yield* Effect.interrupt
				yield* TxRef.set(managed.route, Option.some(attempt))
				yield* generation(managed, attempt, "Serving")
			}),
		).pipe(Effect.andThen(record({ attempt: attempt.id, phase: "Cutover" })))
	return { allocate, start, terminate, retire, cutover, step, releaseHost }
}

const invoke =
	(managed: Managed): T.Invoke =>
	(key, use) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				// Selecting the attempt and registering the call have one linearization point.
				const attempt = yield* Effect.tx(
					Effect.gen(function* () {
						const selected = yield* TxRef.get(managed.route)
						if (Option.isNone(selected))
							return yield* T.Unavailable.make({ fork: managed.entry.id })
						yield* Trust.admission(
							managed.runtime,
							managed.instance,
							selected.value.candidate.identity,
						)
						const calls = yield* TxRef.get(selected.value.calls)
						if (calls >= managed.maxInFlight)
							return yield* T.AdmissionRejected.make({
								fork: managed.entry.id,
								attempt: selected.value.id,
								limit: managed.maxInFlight,
							})
						yield* TxRef.set(selected.value.calls, calls + 1)
						return selected.value
					}),
				)
				return yield* restore(
					Effect.gen(function* () {
						const services = yield* Ref.get(attempt.services)
						return yield* Effect.raceFirst(
							use(Context.getUnsafe(services, key)),
							Effect.raceFirst(
								attempt.unit.failure,
								attempt.unit.exited.pipe(
									Effect.flatMap(() =>
										T.Unavailable.make({ fork: managed.entry.id }),
									),
								),
							),
						)
					}),
				).pipe(Effect.ensuring(TxRef.update(attempt.calls, (n) => n - 1)))
			}),
		)

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
			if (
				HashSet.size(activation.provisionKeys) > 0 ||
				initialSpec.plugin.retry !== undefined
			)
				return yield* T.DriverError.make({
					cause: Cause.die(
						new Error(
							"Managed drivers do not support graph-resolved dependencies or automatic retries",
						),
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
			const policy = policyOf(registration.policy)
			const maxInFlight = registration.maxInFlight ?? 256
			if (
				!valid(policy) ||
				!Number.isSafeInteger(maxInFlight) ||
				maxInFlight < 1 ||
				driver.name !== registration.initial.driver
			)
				return yield* T.DriverError.make({
					cause: Cause.die(new Error("Invalid execution driver registration")),
				})
			const managed: Managed = {
				runtime,
				instance,
				driver,
				required: registration.required,
				facades: registration.facades,
				policy,
				maxInFlight,
				scope: yield* Scope.make(),
				lifecycle: yield* TxRef.make<Lifecycle>({ _tag: "Initializing" }),
				hostFailures: yield* Ref.make<Cause.Cause<unknown>>(Cause.empty),
				route: yield* TxRef.make<Option.Option<Attempt>>(Option.none()),
				attempts: yield* Ref.make<ReadonlyArray<Attempt>>([]),
				next: yield* Ref.make(1),
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
					const currentForks = yield* Snapshots.get(runtime.forks)
					for (const other of HashMap.values(currentForks)) {
						const registered = yield* TxRef.get(other.status.managed)
						if (
							Option.isSome(registered) &&
							registered.value.instance === instance
						)
							return yield* T.DriverError.make({
								cause: Cause.die(
									new Error(`Managed instance already registered: ${instance}`),
								),
							})
					}
					yield* TxRef.update(runtime.trust, (state) => ({
						...state,
						used: true,
					}))
					yield* TxRef.set(entry.status.managed, Option.some(managed))
				}),
			)
			const evidence = yield* Ref.make<ReadonlyArray<T.Evidence>>([])
			const initializationReserve = yield* Ref.make(derive(policy).cleanup)
			const coordinator = engine(managed, policy, evidence, {
				started: yield* Clock.monotonicTimeNanos,
				reserved: initializationReserve,
			})
			const facadeActivation: Activation = {
				...activation,
				published: yield* TxRef.make<Option.Option<ReadonlyArray<Provision>>>(
					Option.some([]),
				),
			}
			yield* Scope.addFinalizer(
				entry.scope,
				Effect.gen(function* () {
					const active = yield* Effect.tx(
						Effect.gen(function* () {
							const state = yield* TxRef.get(managed.lifecycle)
							const active =
								state._tag === "Open" || state._tag === "Closing"
									? state.active
									: Option.none<Run>()
							yield* TxRef.set(managed.lifecycle, { _tag: "Closing", active })
							yield* TxRef.set(managed.route, Option.none())
							return active
						}),
					)
					if (Option.isSome(active)) {
						yield* Deferred.succeed(active.value.cancel, undefined)
						yield* Deferred.await(active.value.reply)
					}
					const remaining = yield* Ref.get(managed.attempts)
					const cleanup = yield* Effect.forEach(remaining, (attempt) =>
						Effect.gen(function* () {
							const coordinator = engine(managed, policy, evidence)
							const result = yield* coordinator.terminate(attempt)
							if (confirmed(result)) return Exit.void
							yield* TxRef.set(runtime.transitionStuck, true)
							const observed = yield* Ref.get(evidence)
							// The release owner records its complete cause before this wait completes.
							yield* coordinator.releaseHost(attempt)
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
						[
							withdraw(runtime, facadeActivation),
							Release.close(managed.scope, Exit.void),
						],
						Effect.exit,
					)
					yield* TxRef.set(managed.lifecycle, { _tag: "Closed" })
					const hostFailures = yield* Ref.get(managed.hostFailures)
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
									facade.publish(invoke(managed)).pipe(
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
							yield* Ref.set(initializationReserve, 0)
							yield* TxRef.set(managed.route, Option.none())
							for (const attempt of yield* Ref.get(managed.attempts)) {
								const result = yield* coordinator.terminate(attempt)
								if (!confirmed(result))
									yield* TxRef.set(runtime.transitionStuck, true)
							}
							const observed = yield* Ref.get(evidence)
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

const execute = Effect.fnUntraced(function* (
	runtime: Runtime,
	managed: Managed,
	request: T.Request,
	policy: Deadlines,
	run: Run,
): Effect.fn.Return<T.Outcome> {
	const { evidence, budget } = run
	const reserved = budget.reserved
	const coordinator = engine(managed, policy, evidence, budget, run.progress)
	const old = yield* TxRef.get(managed.route)
	type Completion = {
		[Tag in T.Outcome["_tag"]]: Omit<
			Extract<T.Outcome, { readonly _tag: Tag }>,
			"evidence"
		>
	}[T.Outcome["_tag"]]
	const finish = (outcome: Completion): Effect.Effect<T.Outcome> =>
		Effect.map(Ref.get(evidence), (evidence) => {
			switch (outcome._tag) {
				case "Accepted":
					return T.Outcome.Accepted({ ...outcome, evidence })
				case "Aborted":
					return T.Outcome.Aborted({ ...outcome, evidence })
				case "Recovered":
					return T.Outcome.Recovered({ ...outcome, evidence })
				case "RecoveryFailed":
					return T.Outcome.RecoveryFailed({ ...outcome, evidence })
				case "Stuck":
					return T.Outcome.Stuck({ ...outcome, evidence })
			}
		})
	const stuck = Effect.gen(function* () {
		yield* TxRef.set(runtime.transitionStuck, true)
		yield* TxRef.set(managed.route, Option.none())
		return yield* finish({
			_tag: "Stuck",
			phase: "Terminating",
			reason: "UnconfirmedTermination",
		})
	})
	// Disposal may close the route after admission but before this worker starts.
	if (Option.isNone(old)) return yield* Effect.interrupt
	const previous = old.value
	const recover = Effect.fnUntraced(function* (
		reason: T.Reason,
	): Effect.fn.Return<T.Outcome> {
		yield* TxRef.set(managed.route, Option.none())
		const retired = yield* coordinator.retire(previous)
		if (!confirmed(retired)) return yield* stuck

		yield* Ref.set(reserved, derive(policy).cleanup)
		const recovered = yield* Effect.result(
			coordinator.allocate(previous.candidate),
		)
		if (recovered._tag === "Failure")
			return yield* finish({
				_tag: "RecoveryFailed",
				phase: "Recovery",
				reason: recovered.failure.reason,
			})
		const restored = yield* Effect.result(coordinator.start(recovered.success))
		if (restored._tag === "Failure") {
			yield* Ref.set(reserved, 0)
			const terminated = yield* coordinator.terminate(recovered.success)
			if (!confirmed(terminated)) return yield* stuck
			return yield* finish({
				_tag: "RecoveryFailed",
				phase: "Recovery",
				reason: restored.failure.reason,
			})
		}
		yield* coordinator.cutover(recovered.success)
		return yield* finish({
			_tag: "Recovered",
			phase: "Recovery",
			reason,
		})
	})
	const abort = Effect.fnUntraced(function* (failure: Failed) {
		yield* Ref.set(reserved, recoveryReserve(policy))
		const healthy = yield* Effect.result(
			coordinator.step(
				previous.id,
				"Readiness",
				Effect.asVoid(Effect.timeoutOption(previous.failure, 0)),
				policy.startup,
			),
		)
		if (healthy._tag === "Failure") return yield* recover(failure.reason)
		return yield* finish({
			_tag: "Aborted",
			phase: failure.phase,
			reason: failure.reason,
		})
	})

	const allocation = yield* Effect.result(
		coordinator.allocate(request.candidate),
	)
	if (allocation._tag === "Failure") return yield* abort(allocation.failure)
	const next = allocation.success
	const started = yield* Effect.result(coordinator.start(next))
	if (started._tag === "Failure") {
		yield* Ref.set(reserved, recoveryReserve(policy))
		const terminated = yield* coordinator.terminate(next)
		if (!confirmed(terminated)) return yield* stuck
		return yield* abort(started.failure)
	}
	yield* coordinator.cutover(next)
	const trial = yield* Effect.result(
		Effect.gen(function* () {
			yield* coordinator.step(
				next.id,
				"Trial",
				Effect.asVoid(Effect.timeoutOption(next.failure, policy.trial)),
				Math.max(policy.trial + 1, policy.startup),
			)
			yield* Ref.set(reserved, recoveryReserve(policy))
			const retired = yield* coordinator.retire(old.value)
			if (!confirmed(retired)) return false
			yield* coordinator.step(
				next.id,
				"Trial",
				Effect.asVoid(Effect.timeoutOption(next.failure, 0)),
				policy.startup,
			)
			return true
		}),
	)
	if (trial._tag === "Success") {
		if (!trial.success) return yield* stuck
		return yield* finish({ _tag: "Accepted", phase: "Complete" })
	}
	yield* TxRef.set(managed.route, Option.none())
	yield* Ref.set(reserved, recoveryReserve(policy))
	// Cleanup evidence precedes every recovery attempt. Never reactivate an old attempt.
	const terminated = yield* coordinator.terminate(next)
	if (!confirmed(terminated)) return yield* stuck
	return yield* recover(trial.failure.reason)
})

export const transition = Effect.fnUntraced(function* (
	request: T.Request,
): Effect.fn.Return<T.Outcome, never, RuntimeContext> {
	const { runtime } = yield* RuntimeContext
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const run: Run = {
				reply: yield* Deferred.make<T.Outcome>(),
				cancel: yield* Deferred.make<void>(),
				evidence: yield* Ref.make<ReadonlyArray<T.Evidence>>([]),
				progress: yield* Ref.make<{ attempt: number; phase: T.Phase }>({
					attempt: 1,
					phase: "Admission",
				}),
				budget: {
					started: yield* Clock.monotonicTimeNanos,
					reserved: yield* Ref.make(0),
				},
			}
			const admitted = yield* Effect.tx(
				Effect.gen(function* () {
					const abort = (reason: T.Reason): T.Outcome =>
						T.Outcome.Aborted({
							reason,
							phase: "Admission",
							evidence: [],
						})
					if (yield* TxRef.get(runtime.transitionBusy)) return abort("Busy")
					if (yield* TxRef.get(runtime.transitionStuck)) return abort("Stuck")
					const forks = yield* Snapshots.get(runtime.forks)
					let managed: Managed | undefined
					for (const entry of HashMap.values(forks)) {
						const selected = yield* TxRef.get(entry.status.managed)
						if (
							Option.isSome(selected) &&
							(typeof request.target === "number"
								? entry.id === request.target
								: selected.value.instance === request.target)
						) {
							managed = selected.value
							break
						}
					}
					if (
						managed === undefined ||
						request.candidate.driver !== managed.driver.name
					)
						return abort("UnsupportedTarget")
					const state = yield* TxRef.get(managed.lifecycle)
					if (state._tag === "Closing" || state._tag === "Closed")
						return abort("Closing")
					if (state._tag !== "Open") return abort("UnsupportedTarget")
					const route = yield* TxRef.get(managed.route)
					if (Option.isNone(route)) return abort("UnsupportedTarget")
					const policy = policyOf({ ...managed.policy, ...request.policy })
					if (!valid(policy)) return abort("InvalidPolicy")
					yield* TxRef.set(runtime.transitionBusy, true)
					yield* TxRef.set(managed.lifecycle, {
						_tag: "Open",
						active: Option.some(run),
					})
					return {
						_tag: "Admitted" as const,
						managed,
						policy,
						attempt: route.value.id,
					}
				}),
			)
			if (admitted._tag !== "Admitted") return admitted
			const { managed, policy } = admitted
			const reply = run.reply
			yield* Ref.set(run.progress, {
				attempt: admitted.attempt,
				phase: "Admission" as const,
			})
			yield* Ref.set(run.budget.reserved, safetyReserve(policy))
			yield* Effect.uninterruptible(
				Effect.gen(function* () {
					const exit = yield* Effect.exit(
						Effect.interruptible(
							Effect.raceFirst(
								execute(runtime, managed, request, policy, run),
								Deferred.await(run.cancel).pipe(
									Effect.andThen(Effect.interrupt),
								),
							).pipe(Effect.provideContext(managed.context)),
						),
					)
					let outcome: T.Outcome
					if (Exit.isFailure(exit)) {
						const location = yield* Ref.get(run.progress)
						yield* Ref.update(
							run.evidence,
							Array.append({ ...location, cause: exit.cause }),
						)
						yield* TxRef.set(managed.route, Option.none())
						yield* Ref.set(run.budget.reserved, 0)
						const coordinator = engine(
							managed,
							policy,
							run.evidence,
							run.budget,
						)
						const attempts = yield* Ref.get(managed.attempts)
						const results = yield* Effect.forEach(
							attempts,
							coordinator.terminate,
						)
						const evidence = yield* Ref.get(run.evidence)
						if (Array.some(results, (result) => !confirmed(result))) {
							yield* TxRef.set(runtime.transitionStuck, true)
							outcome = T.Outcome.Stuck({
								reason: "UnconfirmedTermination",
								phase: "Terminating",
								evidence,
							})
						} else {
							const state = yield* TxRef.get(managed.lifecycle)
							outcome =
								state._tag === "Closing" && Cause.hasInterruptsOnly(exit.cause)
									? T.Outcome.Aborted({
											reason: "Closing",
											phase: location.phase,
											evidence,
										})
									: T.Outcome.RecoveryFailed({
											reason: "CoordinatorDefect",
											phase: location.phase,
											evidence,
										})
						}
					} else outcome = exit.value
					// Release admission before waking the waiter, once, so a subsequent owner cannot be cleared by our finalizer.
					yield* Effect.tx(
						Effect.gen(function* () {
							yield* TxRef.set(runtime.transitionBusy, false)
							const state = yield* TxRef.get(managed.lifecycle)
							if (state._tag === "Open" || state._tag === "Closing")
								yield* TxRef.set(managed.lifecycle, {
									...state,
									active: Option.none(),
								})
						}),
					)
					yield* Deferred.succeed(reply, outcome)
				}),
			).pipe(Effect.forkIn(managed.scope, { uninterruptible: true }))
			return yield* restore(Deferred.await(reply))
		}),
	)
})
