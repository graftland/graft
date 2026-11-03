import {
	Array,
	Cause,
	Clock,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	Ref,
	Scope,
	Semaphore,
} from "effect"
import { SecureRandom } from "effect/crypto"
import * as Retention from "./Retention"
import { cleanupCause } from "../cleanup"
import {
	CodeIdentity,
	ExitStatus,
	Execution,
	Handle,
	Key,
	Limits,
	Load,
	Record,
	SessionError,
	Store,
	Termination,
	type Unit,
	defaults,
	failure,
	keyOf,
	negotiate,
} from "./model"

export interface Options {
	readonly lease?: Duration.Input
	readonly grace?: Duration.Input
	readonly confirmationTimeout?: Duration.Input
	readonly limits?: Limits
}
export interface Open {
	/** Set by the authenticated transport, never taken from an RPC payload. */
	readonly key: Key
	readonly requestId: string
	/** Empty only for a key that has never allocated a generation. */
	readonly expectedGeneration?: number | null
	readonly lease?: Duration.Input
	readonly limits?: Limits
}
interface Entry {
	readonly record: Ref.Ref<Record>
	readonly mutex: Semaphore.Semaphore
	readonly deadline: Ref.Ref<bigint>
	readonly changed: Ref.Ref<Deferred.Deferred<void>>
	readonly unit: Ref.Ref<Option.Option<Unit>>
	readonly exited: Ref.Ref<Option.Option<ExitStatus>>
	readonly unitScope: Scope.Closeable
	readonly loading: Ref.Ref<
		Option.Option<{
			readonly request: Load
			readonly done: Deferred.Deferred<CodeIdentity, SessionError>
		}>
	>
	readonly loadFiber: Ref.Ref<
		Option.Option<Fiber.Fiber<CodeIdentity, SessionError>>
	>
	readonly stopping: Ref.Ref<
		Option.Option<Deferred.Deferred<Termination, SessionError>>
	>
}
const duration = (value: Duration.Input) =>
	Effect.gen(function* () {
		const millis = Duration.toMillis(Duration.fromInputUnsafe(value))
		if (!Number.isFinite(millis) || millis <= 0)
			return yield* failure(
				"InvalidRequest",
				"Runner durations must be finite and positive",
			)
		return millis
	})
const nanos = (millis: number) => BigInt(Math.ceil(millis * 1_000_000))

/**
 * Control-plane state only. Execution owns processes; this supervisor owns the
 * session fibers and admission decisions. Construction recovers every old unit
 * before returning an API that a listener may expose.
 */
export const make = (options: Options = {}) =>
	Effect.gen(function* () {
		const store = yield* Store
		const execution = yield* Execution
		const parent = yield* Effect.scope
		const owner = yield* Scope.fork(parent)
		const leaseDefault = yield* duration(options.lease ?? "15 seconds")
		const grace = yield* duration(options.grace ?? "5 seconds")
		const confirmation = yield* duration(
			options.confirmationTimeout ?? "5 seconds",
		)
		const limits = yield* negotiate(
			options.limits ?? defaults,
			options.limits ?? defaults,
		)
		const records = yield* Ref.make(HashMap.empty<string, Record>())
		const entries = yield* Ref.make(HashMap.empty<string, Entry>())
		const locks = yield* Ref.make(HashMap.empty<string, Semaphore.Semaphore>())
		const closing = yield* Ref.make(false)
		const failed = yield* Deferred.make<never, SessionError>()
		const failures = yield* Ref.make<Cause.Cause<SessionError>>(Cause.empty)
		const poison = (cause: Cause.Cause<SessionError>) =>
			Effect.gen(function* () {
				yield* Ref.update(failures, (previous) =>
					Cause.combine(previous, cause),
				)
				yield* Deferred.failCause(failed, cause)
			})
		const healthy = Effect.gen(function* () {
			if (yield* Ref.get(closing))
				return yield* failure("Closing", "The runner is closing")
			if (yield* Deferred.isDone(failed)) return yield* Deferred.await(failed)
		})
		const persist = (record: Record) =>
			store.save(record).pipe(
				Effect.tapCause(poison),
				Effect.andThen(
					Effect.gen(function* () {
						const obsolete = yield* Ref.modify(records, (all) => {
							const next = HashMap.fromIterable(
								Array.map(
									Retention.retain(
										Array.fromIterable(
											HashMap.values(
												HashMap.set(all, record.handle.token, record),
											),
										),
									),
									(record) => [record.handle.token, record] as const,
								),
							)
							return [
								Array.filter(
									Array.fromIterable(HashMap.keys(all)),
									(token) => !HashMap.has(next, token),
								),
								next,
							] as const
						})
						// Remove only this update's retired entries; another key may have opened meanwhile.
						yield* Ref.update(entries, (all) =>
							Array.reduce(obsolete, all, (all, token) =>
								HashMap.remove(all, token),
							),
						)
					}),
				),
			)
		const save = (entry: Entry, record: Record) =>
			persist(record).pipe(Effect.andThen(Ref.set(entry.record, record)))
		const lockFor = (key: string) =>
			Effect.gen(function* () {
				const candidate = yield* Semaphore.make(1)
				return yield* Ref.modify(locks, (locks) => {
					const existing = HashMap.get(locks, key)
					return Option.isSome(existing)
						? [existing.value, locks]
						: [candidate, HashMap.set(locks, key, candidate)]
				})
			})
		const snapshot = (handle: Handle) =>
			Effect.gen(function* () {
				const all = yield* Ref.get(records)
				const found = HashMap.get(all, handle.token)
				if (
					Option.isNone(found) ||
					keyOf(found.value.handle.key) !== keyOf(handle.key) ||
					found.value.handle.generation !== handle.generation
				)
					return yield* failure("Stale", "Unknown session or generation")
				return found.value
			})
		const latest = (key: Key) =>
			Ref.get(records).pipe(
				Effect.map((all) =>
					Array.reduce(
						Array.filter(
							Array.fromIterable(HashMap.values(all)),
							(record) => keyOf(record.handle.key) === keyOf(key),
						),
						0,
						(generation, record) =>
							Math.max(generation, record.handle.generation),
					),
				),
			)
		const live = (entry: Entry) =>
			Effect.gen(function* () {
				const record = yield* Ref.get(entry.record)
				if (record.handle.generation !== (yield* latest(record.handle.key)))
					return yield* failure(
						"Stale",
						"The session generation has been superseded",
					)
				if (
					record.reason === "Expired" ||
					(yield* Clock.monotonicTimeNanos) >= (yield* Ref.get(entry.deadline))
				)
					return yield* failure("Expired", "The session lease has expired")
				if (record.phase === "Stopping" || record.phase === "Stopped")
					return yield* failure("Stopped", "The session is stopping or stopped")
				return record
			})
		const entryFor = (handle: Handle) =>
			Effect.gen(function* () {
				yield* snapshot(handle)
				if (handle.generation !== (yield* latest(handle.key)))
					return yield* failure(
						"Stale",
						"The session generation has been superseded",
					)
				const found = yield* Ref.get(entries).pipe(
					Effect.map(HashMap.get(handle.token)),
				)
				if (Option.isNone(found))
					return yield* failure(
						"Stopped",
						"The session was retired during recovery",
					)
				return found.value
			})
		const wake = (entry: Entry) =>
			Effect.gen(function* () {
				const next = yield* Deferred.make<void>()
				const previous = yield* Ref.getAndSet(entry.changed, next)
				yield* Deferred.succeed(previous, undefined)
			})

		const terminate = (
			entry: Entry,
		): Effect.Effect<Termination, SessionError> =>
			Effect.gen(function* () {
				const loading = yield* Ref.get(entry.loadFiber)
				if (Option.isSome(loading)) yield* Fiber.interrupt(loading.value)
				const unit = yield* Ref.get(entry.unit)
				let cause: Cause.Cause<SessionError> = Cause.empty
				let result: Termination = {
					kind: "Exited",
					exit: { code: 0, signal: null },
					cause,
				}
				const observed = yield* Ref.get(entry.exited)
				if (Option.isSome(observed))
					result = { ...result, exit: observed.value }
				if (Option.isSome(unit) && Option.isNone(observed)) {
					const child = unit.value
					const graceful = yield* Effect.exit(
						child.interrupt.pipe(
							Effect.andThen(child.exited),
							Effect.timeoutOption(grace),
						),
					)
					if (Exit.isSuccess(graceful) && Option.isSome(graceful.value)) {
						result = { kind: "Exited", exit: graceful.value.value, cause }
					} else {
						if (Exit.isFailure(graceful))
							cause = Cause.combine(cause, graceful.cause)
						const forced = yield* Effect.exit(
							Effect.gen(function* () {
								const killed = yield* Effect.exit(child.kill)
								if (Exit.isFailure(killed))
									cause = Cause.combine(cause, killed.cause)
								return yield* child.exited
							}).pipe(Effect.timeoutOption(confirmation)),
						)
						if (Exit.isFailure(forced))
							cause = Cause.combine(cause, forced.cause)
						if (Exit.isFailure(forced) || Option.isNone(forced.value))
							return yield* failure(
								"Unconfirmed",
								"The child exit could not be confirmed",
								cause,
							)
						result = { kind: "Killed", exit: forced.value.value, cause }
					}
				}
				const closed = yield* Effect.exit(
					Scope.close(entry.unitScope, Exit.void),
				)
				if (Exit.isFailure(closed))
					result = {
						...result,
						cause: Cause.combine(
							result.cause,
							Cause.fail(
								failure(
									"Execution",
									"Execution scope cleanup failed",
									closed.cause,
								),
							),
						),
					}
				yield* entry.mutex.withPermit(
					Effect.gen(function* () {
						const record = yield* Ref.get(entry.record)
						yield* save(entry, {
							...record,
							phase: "Stopped",
							termination: result,
						})
					}),
				)
				return result
			})
		const stop = (
			entry: Entry,
			reason: NonNullable<Record["reason"]>,
		): Effect.Effect<
			Deferred.Deferred<Termination, SessionError>,
			SessionError
		> =>
			entry.mutex.withPermit(
				Effect.uninterruptible(
					Effect.gen(function* () {
						const previous = yield* Ref.get(entry.stopping)
						if (Option.isSome(previous)) return previous.value
						const done = yield* Deferred.make<Termination, SessionError>()
						yield* Ref.set(entry.stopping, Option.some(done))
						const record = yield* Ref.get(entry.record)
						// Fence the session in memory even if persistence is unavailable.
						yield* Ref.set(entry.record, {
							...record,
							phase: "Stopping",
							reason,
						})
						const saved = yield* Effect.exit(
							persist({ ...record, phase: "Stopping", reason }),
						)
						yield* wake(entry)
						yield* terminate(entry).pipe(
							Effect.tap(() =>
								Exit.isFailure(saved)
									? Effect.failCause(saved.cause)
									: Effect.void,
							),
							Effect.onExit((exit) => Deferred.done(done, exit)),
							Effect.catchCause(poison),
							Effect.forkIn(owner),
						)
						return done
					}),
				),
			)
		const watchLease = (entry: Entry): Effect.Effect<void, SessionError> =>
			Effect.gen(function* () {
				while (true) {
					const record = yield* Ref.get(entry.record)
					if (record.phase === "Stopping" || record.phase === "Stopped") return
					const now = yield* Clock.monotonicTimeNanos
					const deadline = yield* Ref.get(entry.deadline)
					const changed = yield* Ref.get(entry.changed)
					if (now >= deadline) {
						const expired = yield* entry.mutex.withPermit(
							Effect.gen(function* () {
								return (
									(yield* Clock.monotonicTimeNanos) >=
									(yield* Ref.get(entry.deadline))
								)
							}),
						)
						if (expired) {
							yield* stop(entry, "Expired")
							return
						}
					} else
						yield* Effect.raceFirst(
							Effect.sleep(Duration.nanos(deadline - now)),
							Deferred.await(changed),
						)
				}
			})

		// A new process never resumes a persisted lease. All unfinished sessions are retired.
		const stored = yield* store.list
		yield* Retention.validate(stored)
		for (const record of Retention.retain(stored))
			yield* Ref.update(records, HashMap.set(record.handle.token, record))
		for (const record of stored) {
			if (record.phase === "Stopped") continue
			const termination =
				record.child === undefined
					? {
							kind: "Exited" as const,
							exit: { code: 0, signal: null },
							cause: Cause.empty,
						}
					: yield* execution.recover(record.child).pipe(
							Effect.timeout(confirmation),
							Effect.catchCause((cause) =>
								Effect.fail(
									failure(
										"Unconfirmed",
										"Orphan recovery did not confirm exit",
										cause,
									),
								),
							),
						)
			yield* persist({
				...record,
				phase: "Stopped",
				reason: "Recovery",
				termination,
			})
		}

		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				yield* Ref.set(closing, true)
				const current = yield* Ref.get(entries)
				const exits = yield* Effect.forEach(HashMap.values(current), (entry) =>
					stop(entry, "Shutdown").pipe(
						Effect.flatMap(Deferred.await),
						Effect.exit,
					),
				)
				let cause = yield* Ref.get(failures)
				for (const exit of exits)
					cause = Cause.combine(
						cause,
						Exit.isFailure(exit) ? exit.cause : exit.value.cause,
					)
				if (cause.reasons.length > 0)
					return yield* Effect.failCause(cleanupCause(cause))
			}),
		)

		return {
			failed,
			status: snapshot,
			/** Authenticated callers use this to recover the comparison value after losing local state. */
			highWater: (key: Key) =>
				Effect.map(latest(key), (generation) =>
					generation === 0 ? null : generation,
				),
			open: (request: Open) =>
				Effect.gen(function* () {
					yield* healthy
					if (
						request.key.identity.length === 0 ||
						request.key.instance.length === 0 ||
						request.requestId.length === 0 ||
						(request.expectedGeneration != null &&
							(!Number.isSafeInteger(request.expectedGeneration) ||
								request.expectedGeneration <= 0))
					)
						return yield* failure(
							"InvalidRequest",
							"Identity and request ids must be nonempty; expectedGeneration must be a positive safe integer or empty",
						)
					const leaseMillis = yield* duration(request.lease ?? leaseDefault)
					const negotiated = yield* negotiate(
						limits,
						request.limits ?? defaults,
					)
					const lock = yield* lockFor(keyOf(request.key))
					return yield* lock.withPermit(
						Effect.gen(function* () {
							yield* healthy
							const all = yield* Ref.get(records)
							const same = Array.filter(
								Array.fromIterable(HashMap.values(all)),
								(record) => keyOf(record.handle.key) === keyOf(request.key),
							)
							const prior = Array.findFirst(
								same,
								(record) => record.requestId === request.requestId,
							)
							if (Option.isSome(prior)) return prior.value
							const generation = yield* latest(request.key)
							if (generation !== (request.expectedGeneration ?? 0))
								return yield* failure(
									"Stale",
									"Open expectedGeneration does not match the generation high-water mark",
								)
							const current = yield* Ref.get(entries)
							for (const entry of HashMap.values(current)) {
								const record = yield* Ref.get(entry.record)
								if (keyOf(record.handle.key) === keyOf(request.key)) {
									const done = yield* stop(entry, "Superseded")
									yield* Deferred.await(done)
								}
							}
							yield* healthy
							if (!Number.isSafeInteger(generation + 1))
								return yield* failure("Storage", "Generation counter exhausted")
							const token = yield* Effect.sync(() =>
								SecureRandom.uuidV4Unsafe(),
							)
							const record: Record = {
								version: 1,
								handle: { key: request.key, token, generation: generation + 1 },
								requestId: request.requestId,
								leaseMillis,
								limits: negotiated,
								phase: "Open",
							}
							// The generation reservation and its owned timer are one cancellation-safe handoff.
							return yield* Effect.uninterruptible(
								Effect.gen(function* () {
									yield* persist(record)
									const now = yield* Clock.monotonicTimeNanos
									const changed = yield* Deferred.make<void>()
									const entry: Entry = {
										record: yield* Ref.make(record),
										mutex: yield* Semaphore.make(1),
										deadline: yield* Ref.make(now + nanos(leaseMillis)),
										changed: yield* Ref.make(changed),
										unit: yield* Ref.make(Option.none<Unit>()),
										exited: yield* Ref.make(Option.none<ExitStatus>()),
										unitScope: yield* Scope.fork(owner),
										loading: yield* Ref.make(
											Option.none<{
												readonly request: Load
												readonly done: Deferred.Deferred<
													CodeIdentity,
													SessionError
												>
											}>(),
										),
										loadFiber: yield* Ref.make(
											Option.none<Fiber.Fiber<CodeIdentity, SessionError>>(),
										),
										stopping: yield* Ref.make(
											Option.none<
												Deferred.Deferred<Termination, SessionError>
											>(),
										),
									}
									yield* Ref.update(entries, HashMap.set(token, entry))
									yield* watchLease(entry).pipe(
										Effect.catchCause(poison),
										Effect.forkIn(owner),
									)
									return record
								}),
							)
						}),
					)
				}),
			renew: (handle: Handle) =>
				Effect.gen(function* () {
					yield* healthy
					const entry = yield* entryFor(handle)
					return yield* entry.mutex.withPermit(
						Effect.gen(function* () {
							const record = yield* live(entry)
							const now = yield* Clock.monotonicTimeNanos
							yield* Ref.set(entry.deadline, now + nanos(record.leaseMillis))
							yield* wake(entry)
							return record.leaseMillis
						}),
					)
				}),
			load: (handle: Handle, request: Load) =>
				Effect.gen(function* () {
					yield* healthy
					const entry = yield* entryFor(handle)
					const done = yield* entry.mutex.withPermit(
						Effect.uninterruptible(
							Effect.gen(function* () {
								const record = yield* live(entry)
								const previous = yield* Ref.get(entry.loading)
								if (Option.isSome(previous)) {
									if (previous.value.request.specifier !== request.specifier)
										return yield* failure(
											"Conflict",
											"Load was already requested with a different specifier",
										)
									return previous.value.done
								}
								const done = yield* Deferred.make<CodeIdentity, SessionError>()
								yield* save(entry, {
									...record,
									phase: "Loading",
									load: request,
								})
								yield* Ref.set(entry.loading, Option.some({ request, done }))
								const fiber = yield* execution
									.spawn(handle, request, (unit) =>
										entry.mutex.withPermit(
											Effect.uninterruptible(
												Effect.gen(function* () {
													const registered = yield* Ref.get(entry.unit)
													if (Option.isSome(registered))
														return yield* failure(
															"Execution",
															"An execution adapter registered more than one child",
														)
													yield* Ref.set(entry.unit, Option.some(unit))
													yield* unit.exited.pipe(
														Effect.tap((exit) =>
															Ref.set(entry.exited, Option.some(exit)),
														),
														Effect.flatMap(() => stop(entry, "Exited")),
														Effect.catchCause(poison),
														Effect.forkIn(owner),
													)

													const current = yield* Ref.get(entry.record)
													yield* save(entry, {
														...current,
														child: unit.identity,
													})
												}),
											),
										),
									)
									.pipe(
										Scope.provide(entry.unitScope),
										Effect.flatMap((code) =>
											entry.mutex.withPermit(
												Effect.gen(function* () {
													const current = yield* live(entry)
													const registered = yield* Ref.get(entry.unit)
													if (Option.isNone(registered))
														return yield* failure(
															"Execution",
															"Execution adapter returned without registering its child",
														)
													yield* save(entry, {
														...current,
														phase: "Loaded",
														code,
													})
													return code
												}),
											),
										),
										Effect.onExit((exit) =>
											Effect.gen(function* () {
												let completed = exit
												if (Exit.isFailure(exit)) {
													const saved = yield* Effect.exit(
														entry.mutex.withPermit(
															Effect.gen(function* () {
																const current = yield* Ref.get(entry.record)
																yield* save(entry, {
																	...current,
																	loadFailure: exit.cause,
																})
															}),
														),
													)
													if (Exit.isFailure(saved))
														completed = Exit.failCause(
															Cause.combine(exit.cause, saved.cause),
														)
												}
												yield* Deferred.done(done, completed)
												if (Exit.isFailure(completed))
													yield* stop(entry, "LoadFailed")
											}),
										),
										Effect.forkIn(owner),
									)
								yield* Ref.set(entry.loadFiber, Option.some(fiber))
								return done
							}),
						),
					)
					return yield* Deferred.await(done)
				}),
			dispose: (handle: Handle) =>
				Effect.gen(function* () {
					const record = yield* snapshot(handle)
					if (record.termination !== undefined) return record.termination
					const entry = yield* entryFor(handle)
					const done = yield* stop(entry, "Disposed")
					return yield* Deferred.await(done)
				}),
		}
	})
