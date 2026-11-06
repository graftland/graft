import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Option,
	Ref,
	Scope,
	TxRef,
	TxSubscriptionRef,
} from "effect"

import * as Plugin from "../Plugin"
import * as Release from "../Release"
import * as T from "../Transition"
import { withdraw } from "./activation"
import type { Activation, ForkEntry, Provision, Runtime } from "./runtime"
import { RuntimeContext } from "./runtimeContext"

interface Attempt {
	readonly id: number
	readonly candidate: T.Candidate
	readonly unit: T.Unit
	readonly failure: Effect.Effect<never, T.DriverError>
	readonly calls: TxRef.TxRef<number>
	readonly scope: Scope.Closeable
	readonly services: Ref.Ref<Context.Context<never>>
	readonly terminated: Ref.Ref<boolean>
}
export interface Managed {
	readonly driver: T.Driver
	readonly facades: ReadonlyArray<T.Facade>
	readonly required: ReadonlyArray<Plugin.OperationIdentity>
	readonly policy: T.Policy
	readonly scope: Scope.Closeable
	readonly coordinatorScope: Scope.Closeable
	readonly route: TxRef.TxRef<Option.Option<Attempt>>
	readonly attempts: Ref.Ref<ReadonlyArray<Attempt>>
	readonly next: Ref.Ref<number>
	readonly context: Context.Context<never>
	readonly entry: ForkEntry
}

const policyOf = (policy?: Partial<T.Policy>): T.Policy => ({
	...T.defaultPolicy,
	...policy,
})
const valid = (policy: T.Policy) =>
	Array.every(
		[policy.startup, policy.probe, policy.drain, policy.stop, policy.terminate],
		(n) => Number.isFinite(n) && n > 0,
	) &&
	Number.isFinite(policy.trial) &&
	policy.trial >= 0

/** Called in the same transaction as a bypass mutation. */
export const check = Effect.fnUntraced(function* (
	runtime: Runtime,
	id?: number,
) {
	const forks = yield* TxSubscriptionRef.get(runtime.forks)
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
	TxSubscriptionRef.update(managed.entry.status.generations, (all) => {
		const item: T.Generation = {
			generation: attempt.id,
			attempt: attempt.id,
			candidate: attempt.candidate,
			state,
		}
		return Array.some(all, (g) => g.attempt === attempt.id)
			? Array.map(all, (g) => (g.attempt === attempt.id ? item : g))
			: [...all, item]
	})

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
	policy: T.Policy,
	evidence: Ref.Ref<ReadonlyArray<T.Evidence>>,
) => {
	const record = (item: T.Evidence) => Ref.update(evidence, Array.append(item))
	const step = <A, E>(
		attempt: number,
		phase: T.Phase,
		effect: Effect.Effect<A, E>,
		budget: number,
	): Effect.Effect<A, Failed> =>
		Effect.gen(function* () {
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
			const result = yield* Effect.timeoutOption(Fiber.await(fiber), budget)
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
	const allocate = Effect.fnUntraced(function* (candidate: T.Candidate) {
		const id = yield* Ref.getAndUpdate(managed.next, (id) => id + 1)
		const unit = yield* step(
			id,
			"Starting",
			Effect.suspend(() => managed.driver.allocate(candidate, id)),
			policy.startup,
		)
		const attempt: Attempt = {
			id,
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
			scope: yield* Scope.make(),
			services: yield* Ref.make(Context.empty()),
			terminated: yield* Ref.make(false),
		}
		yield* Ref.update(managed.attempts, Array.append(attempt))
		yield* generation(managed, attempt, "Starting")
		return attempt
	})
	const start = Effect.fnUntraced(function* (attempt: Attempt) {
		const { unit, id } = attempt
		yield* step(
			id,
			"Starting",
			Effect.raceFirst(
				Scope.provide(unit.start, attempt.scope),
				attempt.failure,
			),
			policy.startup,
		)
		const description = yield* step(
			id,
			"Describing",
			Effect.raceFirst(unit.describe, attempt.failure),
			policy.startup,
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
			policy.startup,
		)
		const services = yield* step(
			id,
			"Readiness",
			Effect.raceFirst(unit.ready, attempt.failure),
			policy.startup,
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
	const terminate = Effect.fnUntraced(function* (attempt: Attempt) {
		if (yield* Ref.get(attempt.terminated)) return true
		// A command's acknowledgement is not exit evidence. Observe exit independently.
		const command = yield* Effect.forkIn(
			attempt.unit.terminate.pipe(
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
			step(attempt.id, "Terminating", attempt.unit.exited, policy.terminate),
		)
		yield* Effect.forkIn(Fiber.interrupt(command), managed.scope)
		if (observed._tag === "Failure") {
			yield* generation(managed, attempt, "Stuck")
			return false
		}
		yield* record({
			attempt: attempt.id,
			phase: "Terminating",
			termination: observed.success,
		})
		yield* Ref.set(attempt.terminated, true)
		yield* generation(managed, attempt, "Terminated")
		// Scope release is separate from execution cleanup evidence; retain any host release failure.
		yield* Effect.result(
			step(
				attempt.id,
				"Terminating",
				Release.close(attempt.scope, Exit.void),
				policy.terminate,
			),
		)
		yield* Ref.update(
			managed.attempts,
			Array.filter((item) => item !== attempt),
		)
		return true
	})
	const retire = Effect.fnUntraced(function* (attempt: Attempt) {
		if (yield* Ref.get(attempt.terminated)) return true
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
				yield* TxRef.set(managed.route, Option.some(attempt))
				yield* generation(managed, attempt, "Serving")
			}),
		).pipe(Effect.andThen(record({ attempt: attempt.id, phase: "Cutover" })))
	return { allocate, start, terminate, retire, cutover, step }
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
						yield* TxRef.update(selected.value.calls, (n) => n + 1)
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
			const forks = yield* TxSubscriptionRef.get(runtime.forks)
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
			const policy = policyOf(registration.policy)
			if (!valid(policy) || driver.name !== registration.initial.driver)
				return yield* T.DriverError.make({
					cause: Cause.die(new Error("Invalid execution driver registration")),
				})
			const managed: Managed = {
				driver,
				required: registration.required,
				facades: registration.facades,
				policy,
				scope: yield* Scope.make(),
				coordinatorScope: yield* Scope.make(),
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
					const snapshot = yield* TxSubscriptionRef.get(entry.status.snapshot)
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
					yield* TxRef.set(entry.status.managed, Option.some(managed))
				}),
			)
			const evidence = yield* Ref.make<ReadonlyArray<T.Evidence>>([])
			const coordinator = engine(managed, policy, evidence)
			const facadeActivation: Activation = {
				...activation,
				published: yield* TxRef.make<Option.Option<ReadonlyArray<Provision>>>(
					Option.some([]),
				),
			}
			yield* Scope.addFinalizer(
				entry.scope,
				Effect.gen(function* () {
					yield* TxRef.set(managed.route, Option.none())
					const stopped = yield* Effect.exit(
						Release.close(managed.coordinatorScope, Exit.void),
					)
					let cause = Exit.isFailure(stopped) ? stopped.cause : Cause.empty
					for (const attempt of yield* Ref.get(managed.attempts)) {
						if (!(yield* coordinator.terminate(attempt))) {
							const observed = yield* Ref.get(evidence)
							cause = Cause.combine(
								cause,
								Cause.die(
									T.DriverError.make({
										cause: Cause.fail({ evidence: observed }),
									}),
								),
							)
							const closed = yield* Effect.exit(
								Release.close(attempt.scope, Exit.void),
							)
							if (Exit.isFailure(closed))
								cause = Cause.combine(cause, closed.cause)
						}
					}
					const withdrawn = yield* Effect.exit(
						withdraw(runtime, facadeActivation),
					)
					const closed = yield* Effect.exit(
						Release.close(managed.scope, Exit.void),
					)
					if (Exit.isFailure(withdrawn))
						cause = Cause.combine(cause, withdrawn.cause)
					if (Exit.isFailure(closed)) cause = Cause.combine(cause, closed.cause)
					if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
				}),
			)
			yield* restore(
				Effect.gen(function* () {
					const initial = yield* coordinator.allocate(registration.initial)
					yield* coordinator.start(initial)
					yield* coordinator.cutover(initial)
					yield* Effect.tx(
						Effect.forEach(
							registration.facades,
							(facade) =>
								facade.publish(invoke(managed)).pipe(
									Effect.provideService(RuntimeContext, {
										runtime,
										activation: facadeActivation,
									}),
								),
							{ discard: true },
						),
					)
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.gen(function* () {
							yield* TxRef.set(managed.route, Option.none())
							for (const attempt of yield* Ref.get(managed.attempts)) {
								if (!(yield* coordinator.terminate(attempt)))
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
	policy: T.Policy,
): Effect.fn.Return<T.Outcome> {
	const evidence = yield* Ref.make<ReadonlyArray<T.Evidence>>([])
	const coordinator = engine(managed, policy, evidence)
	const old = yield* TxRef.get(managed.route)
	type Completion = {
		[Tag in T.Outcome["_tag"]]: Omit<
			Extract<T.Outcome, { readonly _tag: Tag }>,
			"evidence"
		>
	}[T.Outcome["_tag"]]
	const finish = (outcome: Completion): Effect.Effect<T.Outcome> =>
		Effect.map(Ref.get(evidence), (evidence) => ({ ...outcome, evidence }))
	const stuck = Effect.gen(function* () {
		yield* TxRef.set(runtime.transitionStuck, true)
		yield* TxRef.set(managed.route, Option.none())
		return yield* finish({
			_tag: "Stuck",
			phase: "Terminating",
			reason: "UnconfirmedTermination",
		})
	})
	if (Option.isNone(old))
		return yield* finish({
			_tag: "Aborted",
			phase: "Admission",
			reason: "UnsupportedTarget",
		})
	const previous = old.value
	const recover = Effect.fnUntraced(function* (
		reason: T.Reason,
	): Effect.fn.Return<T.Outcome> {
		yield* TxRef.set(managed.route, Option.none())
		if (!(yield* coordinator.retire(previous))) return yield* stuck

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
			if (!(yield* coordinator.terminate(recovered.success)))
				return yield* stuck
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
		if (!(yield* coordinator.terminate(next))) return yield* stuck
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
			const retired = yield* coordinator.retire(old.value)
			if (!retired) return false
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
	// Cleanup evidence precedes every recovery attempt. Never reactivate an old attempt.
	if (!(yield* coordinator.terminate(next))) return yield* stuck
	if (!(yield* coordinator.retire(old.value))) return yield* stuck
	return yield* recover(trial.failure.reason)
})

export const transition = Effect.fnUntraced(function* (
	request: T.Request,
): Effect.fn.Return<T.Outcome, never, RuntimeContext> {
	const { runtime } = yield* RuntimeContext
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const admitted = yield* Effect.tx(
				Effect.gen(function* () {
					const abort = (reason: T.Reason): T.Outcome => ({
						_tag: "Aborted",
						reason,
						phase: "Admission",
						evidence: [],
					})
					if (yield* TxRef.get(runtime.transitionBusy)) return abort("Busy")
					if (yield* TxRef.get(runtime.transitionStuck)) return abort("Stuck")
					const forks = yield* TxSubscriptionRef.get(runtime.forks)
					const entry = Option.getOrUndefined(HashMap.get(forks, request.fork))
					const selected =
						entry === undefined
							? Option.none<Managed>()
							: yield* TxRef.get(entry.status.managed)
					const managed = Option.getOrUndefined(selected)
					if (
						managed === undefined ||
						request.candidate.driver !== managed.driver.name
					)
						return abort("UnsupportedTarget")
					const policy = policyOf({ ...managed.policy, ...request.policy })
					if (!valid(policy)) return abort("InvalidPolicy")
					yield* TxRef.set(runtime.transitionBusy, true)
					return { _tag: "Admitted" as const, managed, policy }
				}),
			)
			if (admitted._tag !== "Admitted") return admitted
			const { managed, policy } = admitted
			const reply = yield* Deferred.make<T.Outcome>()
			yield* Effect.uninterruptible(
				Effect.gen(function* () {
					const exit = yield* Effect.exit(
						Effect.interruptible(
							execute(runtime, managed, request, policy).pipe(
								Effect.provideContext(managed.context),
							),
						),
					)
					let outcome: T.Outcome
					if (Exit.isFailure(exit)) {
						yield* TxRef.set(runtime.transitionStuck, true)
						yield* TxRef.set(managed.route, Option.none())
						outcome = {
							_tag: "Stuck",
							reason: "UnconfirmedTermination",
							phase: "Terminating",
							evidence: [
								{ attempt: 0, phase: "Terminating", cause: exit.cause },
							],
						}
					} else outcome = exit.value
					// Release admission before waking the waiter, once, so a subsequent owner cannot be cleared by our finalizer.
					yield* TxRef.set(runtime.transitionBusy, false)
					yield* Deferred.succeed(reply, outcome)
				}),
			).pipe(Effect.forkIn(managed.coordinatorScope, { uninterruptible: true }))
			return yield* restore(Deferred.await(reply))
		}),
	)
})
