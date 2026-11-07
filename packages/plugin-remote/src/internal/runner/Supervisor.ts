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
	FiberHandle,
	FiberSet,
	HashMap,
	Layer,
	Option,
	RcMap,
	Ref,
	Result,
	Scope,
	Semaphore,
	SynchronizedRef,
} from "effect"
import { SecureRandom } from "effect/crypto"

import * as Release from "@graftland/graft/Release"

import { cleanupCause } from "../cleanup"
import * as FailureGroup from "../FailureGroup"
import {
	childOf,
	defaults,
	Execution,
	ExecutionError,
	keyOf,
	LeaseExpired,
	negotiate,
	PackageError,
	RunnerClosing,
	SessionConflict,
	SessionStopped,
	StaleSession,
	StateStorageError,
	stoppedRecord,
	stoppingRecord,
	Store,
	TerminationUnconfirmed,
	type ActiveRecord,
	type CodeIdentity,
	type ExitStatus,
	type Handle,
	type Key,
	type Limits,
	type Load,
	type LoadedRecord,
	type OpenRecord,
	type SessionKey,
	type SessionRecord,
	type StoppedRecord,
	type StoppingRecord,
	type StopReason,
	type Termination,
	type Unit,
} from "./model"
import * as Retention from "./Retention"

export type SupervisorError =
	| StaleSession
	| LeaseExpired
	| SessionStopped
	| SessionConflict
	| StateStorageError
	| ExecutionError
	| PackageError
	| TerminationUnconfirmed
	| RunnerClosing
export interface Options {
	readonly lease?: Duration.Input
	readonly grace?: Duration.Input
	readonly confirmationTimeout?: Duration.Input
	readonly limits?: Limits
}
export interface Open {
	readonly key: Key
	readonly requestId: string
	readonly expectedGeneration?: number | null
	readonly lease?: Duration.Input
	readonly limits?: Limits
}
export class Supervisor extends Context.Service<
	Supervisor,
	{
		readonly await: Effect.Effect<never, SupervisorError>
		readonly status: (
			handle: Handle,
		) => Effect.Effect<SessionRecord, StaleSession>
		readonly terminated?: (
			handle: Handle,
		) => Effect.Effect<ExitStatus, SupervisorError>
		readonly highWater: (key: Key) => Effect.Effect<number | null>
		readonly open: (
			request: Open,
		) => Effect.Effect<SessionRecord, SupervisorError>
		readonly renew: (handle: Handle) => Effect.Effect<number, SupervisorError>
		readonly load: (
			handle: Handle,
			request: Load,
		) => Effect.Effect<CodeIdentity, SupervisorError>
		readonly dispose: (
			handle: Handle,
		) => Effect.Effect<Termination, SupervisorError>
	}
>()("@graftland/plugin-remote/internal/runner/Supervisor") {}

type Launch = Data.TaggedEnum<{
	Starting: {}
	Registered: { readonly unit: Unit }
}>
const Launch = Data.taggedEnum<Launch>()
type ExecutionState = Data.TaggedEnum<{
	Absent: {}
	Running: { readonly unit: Unit }
	Exited: { readonly exit: ExitStatus }
}>
const ExecutionState = Data.taggedEnum<ExecutionState>()
type LoadReply = Deferred.Deferred<CodeIdentity, SupervisorError>
type StopReply = Deferred.Deferred<Termination, SupervisorError>
type Session = Data.TaggedEnum<{
	Open: { readonly record: typeof OpenRecord.Type; readonly deadline: bigint }
	Loading: {
		readonly record: typeof OpenRecord.Type
		readonly request: Load
		readonly launch: Launch
		readonly reply: LoadReply
		readonly deadline: bigint
	}
	Loaded: {
		readonly record: typeof LoadedRecord.Type
		readonly unit: Unit
		readonly deadline: bigint
	}
	Stopping: {
		readonly record: typeof StoppingRecord.Type
		readonly execution: ExecutionState
		readonly reply: StopReply
	}
	Stopped: {
		readonly record: typeof StoppedRecord.Type
		readonly reply: StopReply
	}
}>
const Session = Data.taggedEnum<Session>()
type Live = Extract<Session, { readonly _tag: "Open" | "Loading" | "Loaded" }>
type Loading = Extract<Session, { readonly _tag: "Loading" }>
type Stopping = Extract<Session, { readonly _tag: "Stopping" }>
interface Entry {
	readonly exitNotice: Deferred.Deferred<ExitStatus, SupervisorError>
	readonly state: SynchronizedRef.SynchronizedRef<Session>
	readonly timer: FiberHandle.FiberHandle<void, never>
	readonly loading: FiberHandle.FiberHandle<void, never>
	readonly scope: Scope.Closeable
	readonly unitScope: Scope.Closeable
}
function snapshot(state: Live): ActiveRecord
function snapshot(state: Session): SessionRecord
function snapshot(state: Session): SessionRecord {
	return state._tag === "Loading"
		? {
				...state.record,
				phase: "Loading",
				load: state.request,
				launch:
					state.launch._tag === "Starting"
						? { _tag: "Starting" }
						: { _tag: "Registered", child: state.launch.unit.identity },
			}
		: state.record
}
const live = (
	state: Session,
	now: bigint,
): Result.Result<Live, LeaseExpired | SessionStopped> => {
	if (state._tag === "Stopping" || state._tag === "Stopped")
		return Result.fail(
			state.record.reason._tag === "Expired"
				? LeaseExpired.make({
						detail: "The session lease has expired",
					})
				: SessionStopped.make({
						detail: "The session is stopping or stopped",
					}),
		)
	return now >= state.deadline
		? Result.fail(
				LeaseExpired.make({
					detail: "The session lease has expired",
				}),
			)
		: Result.succeed(state)
}
const executionOf = (state: Live): ExecutionState => {
	switch (state._tag) {
		case "Open":
			return ExecutionState.Absent()
		case "Loading":
			return state.launch._tag === "Registered"
				? ExecutionState.Running({ unit: state.launch.unit })
				: ExecutionState.Absent()
		case "Loaded":
			return ExecutionState.Running({ unit: state.unit })
	}
}
/** All state transitions are pure; the caller serializes persistence and publication. */
const beginLoad = (
	state: Extract<Session, { _tag: "Open" }>,
	request: Load,
	reply: LoadReply,
): Loading =>
	Session.Loading({
		record: state.record,
		deadline: state.deadline,
		request,
		reply,
		launch: Launch.Starting(),
	})
const registerUnit = (
	state: Session,
	unit: Unit,
): Result.Result<Session, SessionStopped | ExecutionError> => {
	if (state._tag !== "Loading")
		return Result.fail(
			SessionStopped.make({
				detail: "The session is stopping or stopped",
			}),
		)
	if (state.launch._tag === "Registered")
		return Result.fail(
			ExecutionError.make({
				detail: "An execution adapter registered more than one child",
			}),
		)
	return Result.succeed(
		Session.Loading({ ...state, launch: Launch.Registered({ unit }) }),
	)
}
const loaded = (
	state: Session,
	code: CodeIdentity,
): Result.Result<Session, SessionStopped | ExecutionError> => {
	if (state._tag !== "Loading")
		return Result.fail(
			SessionStopped.make({
				detail: "The session is stopping or stopped",
			}),
		)
	if (state.launch._tag !== "Registered")
		return Result.fail(
			ExecutionError.make({
				detail: "Execution adapter returned without registering its child",
			}),
		)
	return Result.succeed(
		Session.Loaded({
			deadline: state.deadline,
			unit: state.launch.unit,
			record: {
				...state.record,
				phase: "Loaded",
				load: state.request,
				code,
				child: state.launch.unit.identity,
			},
		}),
	)
}
const beginStop = (
	state: Live,
	reason: StopReason,
	reply: StopReply,
	exit: Option.Option<ExitStatus>,
): Stopping =>
	Session.Stopping({
		record: stoppingRecord(snapshot(state), reason),
		reply,
		execution: Option.match(exit, {
			onNone: () => executionOf(state),
			onSome: (exit) => ExecutionState.Exited({ exit }),
		}),
	})
const nanos = (millis: number) => BigInt(Math.ceil(millis * 1_000_000))
const emptyTermination: Termination = {
	kind: "Exited",
	exit: { code: 0, signal: null },
	cause: Cause.empty,
}
const exitCause = <A, E>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit) ? exit.cause : Cause.empty

/** A signal is a request; only the exited effect confirms that the execution has stopped. */
const terminate = Effect.fnUntraced(function* (
	execution: ExecutionState,
	grace: number,
	confirmation: number,
): Effect.fn.Return<Termination, TerminationUnconfirmed> {
	if (execution._tag === "Absent") return emptyTermination
	if (execution._tag === "Exited")
		return { ...emptyTermination, exit: execution.exit }
	const child = execution.unit
	const graceful = yield* child.interrupt.pipe(
		Effect.andThen(child.exited),
		Effect.timeoutOption(grace),
		Effect.exit,
	)
	if (Exit.isSuccess(graceful) && Option.isSome(graceful.value))
		return { ...emptyTermination, exit: graceful.value.value }
	const killed = yield* Effect.exit(child.kill)
	const forced = yield* child.exited.pipe(
		Effect.timeoutOption(confirmation),
		Effect.exit,
	)
	const cause = Cause.combine(
		Cause.combine(exitCause(graceful), exitCause(killed)),
		exitCause(forced),
	)
	if (Exit.isFailure(forced) || Option.isNone(forced.value))
		return yield* TerminationUnconfirmed.make({
			detail: "The child exit could not be confirmed",
			cause,
		})
	return {
		kind: "Killed",
		exit: forced.value.value,
		cause,
	} satisfies Termination
})

const initialize = Effect.fnUntraced(function* (options: Options = {}) {
	const store = yield* Store
	const execution = yield* Execution
	const random = yield* SecureRandom.SecureRandom
	const parent = yield* Effect.scope
	const owner = yield* Scope.fork(parent)
	// Cleanup must continue after a health failure so every registered process is reaped.
	const workers = yield* FiberSet.make<void, never>().pipe(Scope.provide(owner))
	const locks = yield* RcMap.make({
		lookup: (_key: SessionKey) => Semaphore.make(1),
	}).pipe(Scope.provide(owner))
	const lease = Duration.toMillis(options.lease ?? "15 seconds")
	const grace = Duration.toMillis(options.grace ?? "5 seconds")
	const confirmation = Duration.toMillis(
		options.confirmationTimeout ?? "5 seconds",
	)
	const limits = options.limits ?? defaults
	const records = yield* Ref.make(HashMap.empty<string, SessionRecord>())
	const entries = yield* Ref.make(HashMap.empty<string, Entry>())
	const health = yield* FailureGroup.make<SupervisorError>().pipe(
		Scope.provide(owner),
	)
	const closing = yield* Ref.make(false)
	return {
		store,
		execution,
		random,
		owner,
		workers,
		locks,
		lease,
		grace,
		confirmation,
		limits,
		records,
		entries,
		health,
		closing,
	}
})
type Runtime = Effect.Success<ReturnType<typeof initialize>>
const operations = (runtime: Runtime) => {
	const {
		store,
		execution,
		workers,
		grace,
		confirmation,
		records,
		entries,
		health,
		closing,
	} = runtime

	const poison = health.failCause
	const observe = <A>(effect: Effect.Effect<A, SupervisorError>) =>
		effect.pipe(Effect.asVoid, Effect.catchCause(poison))
	const healthy = health.check.pipe(
		Effect.andThen(
			Effect.gen(function* () {
				if (yield* Ref.get(closing))
					return yield* RunnerClosing.make({ detail: "The runner is closing" })
			}),
		),
	)
	const persist = (record: SessionRecord) =>
		store
			.save(record)
			.pipe(
				Effect.tapCause(poison),
				Effect.andThen(
					Ref.update(records, (all) => Retention.save(all, record)),
				),
			)
	const status = (handle: Handle) =>
		Ref.get(records).pipe(
			Effect.flatMap((all) => {
				const found = HashMap.get(all, handle.token)
				return Option.isSome(found) &&
					Equal.equals(keyOf(found.value.handle.key), keyOf(handle.key)) &&
					found.value.handle.generation === handle.generation
					? Effect.succeed(found.value)
					: Effect.fail(
							StaleSession.make({
								detail: "Unknown session or generation",
							}),
						)
			}),
		)
	const latest = (key: Key) =>
		Ref.get(records).pipe(
			Effect.map((all) =>
				Array.reduce(
					Array.fromIterable(HashMap.values(all)),
					0,
					(value, record) =>
						Equal.equals(keyOf(record.handle.key), keyOf(key))
							? Math.max(value, record.handle.generation)
							: value,
				),
			),
		)
	const entryFor = Effect.fnUntraced(function* (handle: Handle) {
		yield* status(handle)
		const all = yield* Ref.get(entries)
		const found = HashMap.get(all, handle.token)
		if (Option.isNone(found))
			return yield* SessionStopped.make({
				detail: "The session was retired during recovery",
			})
		return found.value
	})
	const commit = (
		entry: Entry,
		transition: (
			state: Session,
		) => Result.Result<Session, ExecutionError | SessionStopped>,
	) =>
		SynchronizedRef.updateEffect(
			entry.state,
			Effect.fnUntraced(function* (state: Session) {
				const next = yield* Effect.fromResult(transition(state))
				yield* persist(snapshot(next))
				return next
			}),
		)
	const finishStop = Effect.fnUntraced(function* (
		entry: Entry,
		state: Stopping,
		saved: Exit.Exit<void, StateStorageError>,
	) {
		yield* FiberHandle.clear(entry.loading)
		const result = yield* terminate(state.execution, grace, confirmation)
		const closed = yield* Effect.exit(Release.close(entry.unitScope, Exit.void))
		const termination: Termination = {
			...result,
			cause: Cause.combine(result.cause, exitCause(closed)),
		}
		const record = stoppedRecord(
			state.record.previous,
			state.record.reason,
			termination,
		)
		yield* SynchronizedRef.updateEffect(entry.state, () =>
			persist(record).pipe(
				Effect.as(Session.Stopped({ record, reply: state.reply })),
			),
		)
		if (Exit.isFailure(saved)) return yield* Effect.failCause(saved.cause)
		return termination
	})
	/** Called with the session ref locked; the worker starts after its transition is published. */
	const stopLocked = Effect.fnUntraced(function* (
		entry: Entry,
		state: Session,
		reason: StopReason,
		exit: Option.Option<ExitStatus>,
	): Effect.fn.Return<readonly [StopReply, Session]> {
		// Hold the ref lock before publication, so Dispose cannot race the Exited transition.
		// The observation includes stderr; journal and cleanup failures remain in the stop reply.
		if (Option.isSome(exit))
			yield* Deferred.succeed(entry.exitNotice, exit.value)
		if (state._tag === "Stopping" || state._tag === "Stopped")
			return [state.reply, state] as const
		const reply = yield* Deferred.make<Termination, SupervisorError>()
		const next = beginStop(state, reason, reply, exit)
		// Fence in memory even when the journal cannot acknowledge the transition.
		const saved = yield* Effect.exit(persist(next.record))
		yield* FiberSet.run(
			workers,
			finishStop(entry, next, saved).pipe(
				Effect.onExit((result) =>
					Deferred.done(
						entry.exitNotice,
						Exit.map(result, (termination) => termination.exit),
					),
				),
				Effect.onExit((result) => Deferred.done(reply, result)),
				observe,
			),
			{ startImmediately: false },
		)
		return [reply, next] as const
	})
	const stop = (
		entry: Entry,
		reason: StopReason,
		exit: Option.Option<ExitStatus> = Option.none(),
	) =>
		SynchronizedRef.modifyEffect(entry.state, (state) =>
			stopLocked(entry, state, reason, exit),
		).pipe(Effect.uninterruptible)
	const scheduleLease = (entry: Entry, deadline: bigint) =>
		FiberHandle.run(
			entry.timer,
			observe(
				Effect.gen(function* () {
					const now = yield* Clock.monotonicTimeNanos
					yield* Effect.sleep(
						Duration.nanos(deadline > now ? deadline - now : 0n),
					)
					yield* SynchronizedRef.updateEffect(entry.state, (state) => {
						if (
							state._tag === "Stopping" ||
							state._tag === "Stopped" ||
							state.deadline !== deadline
						)
							return Effect.succeed(state)
						return stopLocked(
							entry,
							state,
							{ _tag: "Expired" },
							Option.none(),
						).pipe(Effect.map(([, next]) => next))
					})
				}),
			),
			{ startImmediately: false },
		)
	const register = (entry: Entry, unit: Unit) =>
		SynchronizedRef.updateEffect(
			entry.state,
			Effect.fnUntraced(function* (state: Session) {
				const now = yield* Clock.monotonicTimeNanos
				const current = yield* Effect.fromResult(live(state, now))
				const next = yield* Effect.fromResult(registerUnit(current, unit))
				yield* unit.renew(
					Number(current.deadline - (yield* Clock.monotonicTimeNanos)) /
						1_000_000,
				)
				yield* persist(snapshot(next))
				yield* FiberSet.run(
					workers,
					observe(
						unit.exited.pipe(
							Effect.flatMap((exit) =>
								stop(entry, { _tag: "Exited" }, Option.some(exit)),
							),
						),
					),
				)
				return next
			}),
		).pipe(Effect.uninterruptible)
	const runLoad = (entry: Entry, state: Loading) =>
		execution
			.spawn(state.record.handle, state.request, state.record.limits)
			.pipe(
				Scope.provide(entry.unitScope),
				Effect.flatMap((unit) =>
					register(entry, unit).pipe(
						Effect.andThen(unit.start),
						Effect.as(unit.code),
					),
				),
				Effect.tap((code) => commit(entry, (current) => loaded(current, code))),
				Effect.onExit(
					Effect.fnUntraced(function* (
						result: Exit.Exit<CodeIdentity, SupervisorError>,
					) {
						if (Exit.isSuccess(result)) {
							yield* Deferred.done(state.reply, result)
							return
						}
						const current = yield* SynchronizedRef.get(entry.state)
						if (current._tag === "Loading")
							yield* stop(entry, { _tag: "LoadFailed", cause: result.cause })
						const healthCause = yield* health.cause
						yield* Deferred.failCause(
							state.reply,
							Cause.combine(result.cause, healthCause),
						)
					}),
				),
				// Load's caller observes its complete exit through the reply, including cancellation.
				Effect.exit,
				Effect.asVoid,
			)

	return {
		persist,
		status,
		latest,
		entryFor,
		stop,
		scheduleLease,
		runLoad,
		healthy,
	}
}
type Operations = ReturnType<typeof operations>
const recover = Effect.fnUntraced(function* (
	runtime: Runtime,
	actions: Operations,
) {
	const { store, execution, confirmation, records } = runtime
	const { persist } = actions
	// Recover before the service is published. Construction does not resume old leases.
	const stored = yield* store.list
	yield* Ref.set(
		records,
		HashMap.fromIterable(
			Array.map(stored, (record) => [record.handle.token, record] as const),
		),
	)
	for (const record of stored) {
		if (record.phase === "Stopped") continue
		const child = childOf(record)
		const termination = Option.isNone(child)
			? emptyTermination
			: yield* execution.recover(child.value).pipe(
					Effect.timeout(confirmation),
					Effect.catchTags({
						ExecutionError: (error) =>
							Effect.fail(
								TerminationUnconfirmed.make({
									detail: "Orphan recovery did not confirm exit",
									cause: Cause.fail(error),
								}),
							),
						TimeoutError: (error) =>
							Effect.fail(
								TerminationUnconfirmed.make({
									detail: "Orphan recovery did not confirm exit",
									cause: Cause.fail(error),
								}),
							),
					}),
				)
		yield* persist(
			stoppedRecord(
				record.phase === "Stopping" ? record.previous : record,
				{ _tag: "Recovery" },
				termination,
			),
		)
	}
})
const ownShutdown = Effect.fnUntraced(function* (
	runtime: Runtime,
	actions: Operations,
) {
	const { entries, health, closing } = runtime
	const { stop } = actions
	yield* Effect.addFinalizer(
		Effect.fnUntraced(function* () {
			yield* Ref.set(closing, true)
			const all = yield* Ref.get(entries)
			const exits = yield* Effect.forEach(HashMap.values(all), (entry) =>
				stop(entry, { _tag: "Shutdown" }).pipe(
					Effect.flatMap(Deferred.await),
					Effect.exit,
				),
			)
			const initial: Cause.Cause<unknown> = yield* health.cause
			const cause = Array.reduce(exits, initial, (cause, exit) =>
				Cause.combine(
					cause,
					Exit.isFailure(exit) ? exit.cause : exit.value.cause,
				),
			)
			if (cause.reasons.length > 0)
				return yield* Effect.failCause(cleanupCause(cause))
		}),
	)
})
const protocol = Effect.fnUntraced(function* (
	runtime: Runtime,
	actions: Operations,
) {
	const { random, owner, locks, lease, limits, records, entries, health } =
		runtime
	const {
		persist,
		status,
		latest,
		entryFor,
		stop,
		scheduleLease,
		runLoad,
		healthy,
	} = actions
	return Supervisor.of({
		await: health.await,
		status,
		terminated: Effect.fnUntraced(function* (handle: Handle) {
			const record = yield* status(handle)
			if (record.phase === "Stopped") return record.termination.exit
			const entry = yield* entryFor(handle)
			return yield* Deferred.await(entry.exitNotice)
		}),
		highWater: (key) =>
			latest(key).pipe(Effect.map((value) => (value === 0 ? null : value))),
		open: Effect.fnUntraced(function* (request: Open) {
			yield* healthy
			const leaseMillis = Duration.toMillis(request.lease ?? lease)
			const negotiated = negotiate(limits, request.limits ?? defaults)
			const lock = yield* RcMap.get(locks, keyOf(request.key))
			return yield* Effect.gen(function* () {
				yield* healthy
				const allRecords = yield* Ref.get(records)
				const same = Array.filter(
					Array.fromIterable(HashMap.values(allRecords)),
					(row) => Equal.equals(keyOf(row.handle.key), keyOf(request.key)),
				)
				const prior = Array.findFirst(
					same,
					(row) => row.requestId === request.requestId,
				)
				if (Option.isSome(prior)) return prior.value
				const generation = yield* latest(request.key)
				if (generation !== (request.expectedGeneration ?? 0))
					return yield* StaleSession.make({
						detail:
							"Open expectedGeneration does not match the generation high-water mark",
					})
				for (const record of same) {
					const allEntries = yield* Ref.get(entries)
					const entry = HashMap.get(allEntries, record.handle.token)
					if (Option.isSome(entry))
						yield* stop(entry.value, { _tag: "Superseded" }).pipe(
							Effect.flatMap(Deferred.await),
							Effect.tap((result) =>
								result.cause.reasons.length === 0
									? Effect.void
									: Effect.logWarning(
											"Superseded remote execution cleanup failed",
											result.cause,
										).pipe(
											Effect.annotateLogs({
												"remote.identity": record.handle.key.identity,
												"remote.instance": record.handle.key.instance,
												"remote.generation": record.handle.generation,
											}),
										),
							),
						)
				}
				yield* healthy
				const token = yield* random.uuidV4()
				const record: typeof OpenRecord.Type = {
					version: 1,
					phase: "Open",
					handle: {
						key: request.key,
						token,
						generation: generation + 1,
					},
					requestId: request.requestId,
					leaseMillis,
					limits: negotiated,
				}
				return yield* Effect.uninterruptible(
					Effect.gen(function* () {
						yield* persist(record)
						const deadline =
							(yield* Clock.monotonicTimeNanos) + nanos(leaseMillis)
						const scope = yield* Scope.fork(owner)
						const entry: Entry = {
							exitNotice: yield* Deferred.make<ExitStatus, SupervisorError>(),
							state: yield* SynchronizedRef.make<Session>(
								Session.Open({ record, deadline }),
							),
							scope,
							unitScope: yield* Scope.fork(scope),
							timer: yield* FiberHandle.make<void, never>().pipe(
								Scope.provide(scope),
							),
							loading: yield* FiberHandle.make<void, never>().pipe(
								Scope.provide(scope),
							),
						}
						// The store's retention policy is also the in-memory eviction policy.
						const retained = yield* Ref.get(records)
						const old = yield* Ref.modify(
							entries,
							(all) =>
								[
									Array.filter(
										Array.fromIterable(HashMap.entries(all)),
										([key]) => !HashMap.has(retained, key),
									),
									HashMap.set(
										HashMap.filter(all, (_, key) => HashMap.has(retained, key)),
										token,
										entry,
									),
								] as const,
						)
						for (const [, retired] of old)
							yield* Release.close(retired.scope, Exit.void)
						yield* scheduleLease(entry, deadline)
						return record
					}),
				)
			}).pipe(lock.withPermit)
		}, Effect.scoped),
		renew: Effect.fnUntraced(function* (handle: Handle) {
			yield* healthy
			const entry = yield* entryFor(handle)
			// Arming the new timer interrupts the old one, so the new deadline must be stored too.
			// Telling the child may block on its control pipe, so that step stays interruptible:
			// if it is cut short, nothing is stored and the old timer keeps its deadline.
			return yield* Effect.uninterruptibleMask((restore) =>
				SynchronizedRef.modifyEffect(
					entry.state,
					Effect.fnUntraced(function* (state: Session) {
						const now = yield* Clock.monotonicTimeNanos
						const current = yield* Effect.fromResult(live(state, now))
						const running = executionOf(current)
						if (running._tag === "Running")
							yield* restore(running.unit.renew(current.record.leaseMillis))
						const deadline = now + nanos(current.record.leaseMillis)
						yield* scheduleLease(entry, deadline)
						return [
							current.record.leaseMillis,
							{ ...current, deadline },
						] as const
					}),
				),
			)
		}),
		load: Effect.fnUntraced(function* (handle: Handle, request: Load) {
			yield* healthy
			const entry = yield* entryFor(handle)
			const reply = yield* SynchronizedRef.modifyEffect(
				entry.state,
				Effect.fnUntraced(function* (state: Session) {
					const now = yield* Clock.monotonicTimeNanos
					const current = yield* Effect.fromResult(live(state, now))
					if (current._tag !== "Open") {
						const before =
							current._tag === "Loading" ? current.request : current.record.load
						if (
							before.contract !== request.contract ||
							before.implementation !== request.implementation ||
							(before.digest ?? false) !== (request.digest ?? false)
						)
							return yield* SessionConflict.make({
								detail:
									"Load was already requested with a different deployment",
							})
						return [
							current._tag === "Loading"
								? Deferred.await(current.reply)
								: Effect.succeed(current.record.code),
							current,
						] as const
					}
					const done = yield* Deferred.make<CodeIdentity, SupervisorError>()
					const next = beginLoad(current, request, done)
					yield* persist(snapshot(next))
					if (next._tag === "Loading")
						yield* FiberHandle.run(entry.loading, runLoad(entry, next), {
							startImmediately: false,
						})
					return [Deferred.await(done), next] as const
				}),
			).pipe(Effect.uninterruptible)
			return yield* reply
		}),
		dispose: Effect.fnUntraced(function* (handle: Handle) {
			const record = yield* status(handle)
			if (record.phase === "Stopped") return record.termination
			const entry = yield* entryFor(handle)
			return yield* stop(entry, { _tag: "Disposed" }).pipe(
				Effect.flatMap(Deferred.await),
			)
		}),
	})
})
export const make = Effect.fnUntraced(function* (options: Options = {}) {
	const runtime = yield* initialize(options)
	const actions = operations(runtime)
	yield* recover(runtime, actions)
	yield* ownShutdown(runtime, actions)
	return yield* protocol(runtime, actions)
})
export const layer = (options: Options = {}) =>
	Layer.effect(Supervisor, make(options))
