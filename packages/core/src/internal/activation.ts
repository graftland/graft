/**
 * The supervision loop of a single fork.
 *
 * Each iteration acquires the fork's dependencies, runs `apply` in a fresh
 * activation, waits until the specification or a dependency changes, and
 * tears the activation down. Teardown follows a fixed order instead of
 * relying on finalizer registration order:
 *
 * 1. stop `apply` if it is still running;
 * 2. withdraw everything the activation published and close it to further
 *    publishing, so nobody new can lease it;
 * 3. wait until every consumer has released those provisions;
 * 4. stop supervised tasks and close their scopes, waiting for cleanup;
 * 5. close the activation scope (child forks, resources, handlers);
 * 6. release the leases the activation itself holds, whatever happened before.
 *
 * All phases contribute to one cleanup Exit. Failed state or fork disposal owns
 * that result; logging it is never a substitute for handing it to the caller.
 */
import {
	Array,
	Cause,
	Context,
	Data,
	Duration,
	Effect,
	Equal,
	Exit,
	Fiber,
	FiberSet,
	HashMap,
	HashSet,
	Option,
	Pull,
	Ref,
	Schedule,
	Schema,
	Scope,
	TxRef,
} from "effect"

import * as Finalization from "../Finalization"
import { ForkState } from "../Fork"
import { Graft, ServiceConflict } from "../Graft"
import { isOptional, UnitTerm, type Update } from "../Plugin"
import * as Transition from "../Transition"
import { publicationCycle, resolutionChanged } from "./dependencies"
import { setState } from "./forkState"
import * as Generations from "./generations"
import {
	realmKey,
	realmOf,
	Realms,
	type Activation,
	type ForkStatus,
	type GraphNode,
	type Provision,
	type Runtime,
	type ServiceKey,
	type Slot,
	type Spec,
} from "./runtime"
import * as Slots from "./slots"
import * as TaskGroup from "./tasks"

// A finalizer forwarding exactly the requested interrupt is indistinguishable from acknowledging cancellation.
const interruptedBy = <E>(cause: Cause.Cause<E>, id: number) =>
	Array.every(
		cause.reasons,
		(reason) => reason._tag === "Interrupt" && reason.fiberId === id,
	)

/** Observe cancellation without losing the child's final Exit at an interruption boundary. */
const cancelOnChange = <A, E, R, B, E2, R2>(
	operation: Effect.Effect<A, E, R>,
	changed: Effect.Effect<unknown>,
	handoff: (
		result: Exit.Exit<A, E>,
		settled: Exit.Exit<boolean>,
		restore: typeof Effect.interruptible,
		expectedCancellation: (cause: Cause.Cause<E>) => boolean,
	) => Effect.Effect<B, E2, R2>,
	observe: (result: Exit.Exit<A, E>) => Effect.Effect<void> = () => Effect.void,
) =>
	Effect.scoped(
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const id = yield* Effect.withFiber((self) => Effect.succeed(self.id))
				const worker = yield* Effect.forkScoped(restore(operation))
				const raced = yield* Effect.exit(
					restore(
						Effect.raceFirst(
							Effect.as(changed, true),
							Effect.as(Fiber.await(worker), false),
						),
					),
				)
				yield* Fiber.interrupt(worker)
				const result = yield* Fiber.await(worker)
				yield* observe(result)
				// A stop can arrive during masked cleanup or observation. Handoff stays masked.
				const settled = yield* Effect.exit(restore(raced))
				return yield* handoff(result, settled, restore, (cause) =>
					interruptedBy(cause, id),
				)
			}),
		),
	)

/** How long teardown waits for consumers before warning about a possible cycle. */
const drainWarning = Duration.seconds(10)

interface Resolution {
	readonly watch: HashMap.HashMap<ServiceKey, Slot>
	readonly prepared: Prepared
	readonly spec: Spec
	readonly missing: ReadonlyArray<string>
	readonly provisions: ReadonlyArray<Provision>
	/** Ambient fallback values; these take no lease and may be shadowed by a provision. */
	readonly ambient: ReadonlyArray<readonly [service: string, value: unknown]>
	/** Realm keys without a provision, including dependencies using ambient fallback. */
	readonly unprovided: ReadonlyArray<ServiceKey>
}

interface Running {
	readonly resolution: Resolution
	readonly activation: Activation
	readonly scope: Scope.Closeable
	/** Everything plugin code may require: the activation is where plugin requirements are discharged. */
	readonly context: Context.Context<unknown>
	/** The fiber running `apply`; teardown stops it before withdrawing anything. */
	readonly fiber: Fiber.Fiber<void | Update<unknown, unknown, unknown>, unknown>
	readonly tasks: TaskGroup.Group
	readonly updateCleanup: Ref.Ref<Cause.Cause<unknown>>
}

type Outcome = Data.TaggedEnum<{
	Restart: {}
	Failed: {
		readonly resolution: Resolution
		readonly cause: Cause.Cause<unknown>
	}
}>

const Outcome = Data.taggedEnum<Outcome>()

/** What acquiring a fork's dependencies produced. */
type Acquired = Data.TaggedEnum<{
	Missing: { readonly resolution: Resolution }
	Running: { readonly running: Running }
}>

const Acquired = Data.taggedEnum<Acquired>()

interface Retry {
	readonly resolution: Resolution
	readonly step: (input: unknown) => Pull.Pull<unknown, never, unknown>
}

/** A schedule belongs to one spec and the exact provisions that attempt used. */
const sameAttempt = (left: Resolution, right: Resolution): boolean =>
	left.spec === right.spec &&
	left.provisions.length === right.provisions.length &&
	Array.every(
		left.provisions,
		(provision, index) => provision === right.provisions[index],
	) &&
	Equal.equals(left.unprovided, right.unprovided)

const restart = Outcome.Restart()

interface Prepared {
	readonly plugin: Spec["plugin"]
	readonly slots: HashMap.HashMap<ServiceKey, Slot>
	readonly lookups: ReadonlyArray<{
		readonly optional: boolean
		readonly service: string
		readonly qualified: ServiceKey
		readonly slot: Slot
		readonly ambient: () => Option.Option<unknown>
	}>
}

const resolve = Effect.fnUntraced(function* (
	spec: Spec,
	prepared: Prepared,
): Effect.fn.Return<Resolution> {
	const lookups = yield* Effect.forEach(prepared.lookups, (lookup) =>
		Effect.map(TxRef.get(lookup.slot.provision), (found) => ({
			...lookup,
			found,
			ambient: Option.isSome(found) ? Option.none() : lookup.ambient(),
		})),
	)
	const unresolved = Array.filter(lookups, (lookup) =>
		Option.isNone(lookup.found),
	)
	const absent = Array.filter(unresolved, (lookup) =>
		Option.isNone(lookup.ambient),
	)
	return {
		prepared,
		watch: HashMap.fromIterable(
			Array.map(
				unresolved,
				(lookup) => [lookup.qualified, lookup.slot] as const,
			),
		),
		spec,
		provisions: Array.getSomes(Array.map(lookups, (lookup) => lookup.found)),
		ambient: Array.getSomes(
			Array.map(unresolved, (lookup) =>
				Option.map(lookup.ambient, (value) => [lookup.service, value] as const),
			),
		),
		missing: Array.map(
			Array.filter(absent, (lookup) => !lookup.optional),
			(lookup) => lookup.service,
		),
		unprovided: Array.map(unresolved, (lookup) => lookup.qualified),
	}
})

export { setState } from "./forkState"

const waitDrained = Effect.fnUntraced(function* (
	published: ReadonlyArray<Provision>,
) {
	for (const provision of published) {
		const consumers = yield* TxRef.get(provision.consumers)
		if (HashSet.size(consumers) > 0) return yield* Effect.txRetry
	}
}, Effect.tx)

/**
 * Withdraws what an activation published, closes it to further publishing,
 * and waits until no consumer holds a lease on any of it.
 */
export const withdraw = Effect.fnUntraced(function* (
	runtime: Runtime,
	activation: Activation,
) {
	const published = yield* Effect.tx(
		Effect.gen(function* () {
			const current = yield* TxRef.get(activation.published)
			const published = Option.getOrElse(current, () => [])
			yield* TxRef.set(activation.published, Option.none())
			yield* TxRef.update(activation.node.state, (state) => ({
				...state,
				resolutions: HashMap.modify(
					state.resolutions,
					activation.generation,
					(resolution) => ({ ...resolution, watch: HashMap.empty() }),
				),
			}))
			for (const provision of published) {
				const current = yield* TxRef.get(provision.slot.provision)
				if (Option.exists(current, (current) => current === provision)) {
					yield* TxRef.set(provision.slot.provision, Option.none())
				}
				yield* Slots.release(runtime, provision.slot)
			}
			return published
		}),
	)
	const drained = yield* Effect.timeoutOption(
		waitDrained(published),
		drainWarning,
	)
	if (Option.isNone(drained)) {
		const services = Array.join(
			Array.map(published, (provision) => provision.service),
			", ",
		)
		yield* Effect.logWarning(
			`Still waiting for consumers of ${services}; a teardown cycle may be holding them`,
		)
		yield* waitDrained(published)
	}
})

const reportFailure = (message: string, exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
		? Effect.logError(message, exit.cause)
		: Effect.void

export const supervise = Effect.fnUntraced(function* (
	runtime: Runtime,
	id: number,
	specRef: TxRef.TxRef<Spec>,
	/** The selected resolution or update, never a newer request still waiting in specRef. */
	processing: TxRef.TxRef<Spec>,
	node: GraphNode,
	status: ForkStatus,
	completion?: Ref.Ref<Exit.Exit<void, unknown>>,
) {
	const cleanup =
		completion ?? (yield* Ref.make<Exit.Exit<void, unknown>>(Exit.void))
	const realms = yield* Realms
	const lifecycle = yield* Transition.Lifecycle
	const permit = yield* Ref.make(Option.none<number>())
	const environment = yield* Transition.Environment
	/** What the fork inherits from where it was loaded: references and ambient services. */
	const inherited = yield* Effect.context<never>()
	/** Unit-built infrastructure (environment modules) refines inherited references for this activation. */
	const references = Context.merge(
		Context.merge(runtime.ambient, inherited),
		environment,
	)

	// A supervisor retains its handles through Pending, running, teardown, and failed retry.
	const held = yield* TxRef.make<Prepared | undefined>(undefined)
	const prepare = Effect.gen(function* () {
		const spec = yield* TxRef.get(specRef)
		const previous = yield* TxRef.get(held)
		if (previous?.plugin === spec.plugin) return previous
		let slots = HashMap.empty<ServiceKey, Slot>()
		const lookups = yield* Effect.forEach(spec.plugin.inject, (dependency) =>
			Effect.gen(function* () {
				const key = isOptional(dependency) ? dependency.key : dependency
				const qualified = realmKey(realmOf(realms, key.key), key.key)
				const existing = HashMap.get(slots, qualified)
				const slot = Option.isSome(existing)
					? existing.value
					: yield* Slots.retain(runtime, qualified)
				slots = HashMap.set(slots, qualified, slot)
				return {
					optional: isOptional(dependency),
					service: key.key,
					qualified,
					slot,
					ambient: () =>
						Context.getOption(
							Context.isReference(key)
								? references
								: Context.merge(runtime.ambient, environment),
							key,
						),
				}
			}),
		)
		if (previous !== undefined) {
			for (const slot of HashMap.values(previous.slots))
				yield* Slots.release(runtime, slot)
		}
		const prepared: Prepared = { plugin: spec.plugin, slots, lookups }
		yield* TxRef.set(held, prepared)
		return prepared
	})
	const resolveCurrent = (prepared: Prepared) =>
		Effect.flatMap(TxRef.get(specRef), (spec) => resolve(spec, prepared))

	/** Resolves to the new spec if the spec changed, or `None` if a dependency changed. */
	const waitChange = Effect.fnUntraced(function* (resolution: Resolution) {
		const current = yield* TxRef.get(specRef)
		if (current !== resolution.spec) return Option.some(current)
		if (
			resolution.provisions.length === 0 &&
			resolution.unprovided.length === 0
		)
			return yield* Effect.txRetry
		return (yield* resolutionChanged(resolution))
			? Option.none<Spec>()
			: yield* Effect.txRetry
	}, Effect.tx)

	const acquire = Effect.gen(function* () {
		const acquired = yield* Effect.tx(
			Effect.gen(function* () {
				const prepared = yield* prepare
				const resolution = yield* resolveCurrent(prepared)
				yield* TxRef.set(processing, resolution.spec)
				const generation =
					resolution.missing.length === 0
						? yield* Generations.acquire(runtime, node, {
								watch: resolution.watch,
								provisions: resolution.provisions,
							})
						: undefined
				return { resolution, generation }
			}),
		)
		const { resolution, generation } = acquired
		if (generation === undefined) return Acquired.Missing({ resolution })
		const grantedTerm = yield* Ref.get(permit)
		const inheritedTerm = yield* UnitTerm
		const term = Option.orElse(grantedTerm, () => inheritedTerm)
		const scope = yield* Scope.make()
		const tasks = yield* TaskGroup.make
		const published = yield* TxRef.make(
			Option.some<ReadonlyArray<Provision>>([]),
		)
		const activation: Activation = {
			fork: id,
			generation,
			node,
			status,
			tasks: Option.some(tasks),
			published,
			fallback: references,
			provisionKeys: HashSet.fromIterable(
				Array.map(resolution.provisions, (provision) => provision.service),
			),
		}
		const context = Context.makeUnsafe<unknown>(
			new Map<string, unknown>([
				...inherited.mapUnsafe,
				...environment.mapUnsafe,
				...resolution.ambient,
				...Array.map(
					resolution.provisions,
					(provision) => [provision.service, provision.value] as const,
				),
				[Scope.Scope.key, scope],
				[Graft.key, { runtime, activation }],
				[UnitTerm.key, term],
			]),
		)
		const spec = resolution.spec
		if (Option.isSome(lifecycle)) yield* lifecycle.value.expose(context)
		yield* setState(runtime, id, status, ForkState.Loading(), spec)
		const fiber = yield* Effect.suspend(() =>
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the activation discharges plugin requirements and teardown observes its complete Exit
			spec.plugin.decode(spec.input),
		).pipe(
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- plugin errors are preserved in the fiber's Exit
			Effect.flatMap((config) => spec.plugin.apply(config)),
			Effect.withSpan(`graft.plugin ${spec.plugin.name}`, {
				attributes: {
					"graft.fork": id,
					"graft.plugin": spec.plugin.name,
					"graft.revision": spec.revision,
				},
			}),
			inActivation(context, spec),
			Effect.forkIn(scope),
		)
		const running: Running = {
			updateCleanup: yield* Ref.make<Cause.Cause<unknown>>(Cause.empty),
			resolution,
			tasks,
			activation,
			scope,
			context,
			fiber,
		}
		return Acquired.Running({ running })
	})

	const pending = Effect.fnUntraced(function* (resolution: Resolution) {
		yield* setState(
			runtime,
			id,
			status,
			ForkState.Pending({ missing: resolution.missing }),
			resolution.spec,
		)
		yield* Effect.tx(
			Effect.gen(function* () {
				if ((yield* TxRef.get(specRef)) !== resolution.spec) return
				const next = yield* resolveCurrent(resolution.prepared)
				const unchanged =
					next.spec === resolution.spec &&
					Equal.equals(next.missing, resolution.missing)
				if (unchanged) return yield* Effect.txRetry
			}),
		)
		return restart
	})

	/** Runs plugin code with the activation's context, which discharges whatever it requires. */
	const inActivation =
		(context: Context.Context<unknown>, spec: Spec) =>
		<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
			Effect.updateContext<A, E, unknown, never>(
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- this is where plugin requirements are discharged
				Effect.annotateLogs(effect, {
					"graft.fork": id,
					"graft.plugin": spec.plugin.name,
				}),
				() => context,
			)

	const run = Effect.fnUntraced(function* (running: Running) {
		const { resolution } = running
		let spec = resolution.spec
		const fiber = running.fiber
		const first = yield* Effect.raceFirst(
			Effect.asSome(Fiber.await(fiber)),
			Effect.as(waitChange(resolution), Option.none()),
		)
		if (Option.isNone(first)) return restart
		const exit = first.value
		if (exit._tag === "Failure")
			return Outcome.Failed({
				resolution,
				cause: exit.cause,
			})
		yield* setState(runtime, id, status, ForkState.Active(), spec)
		const update = exit.value
		while (true) {
			const next = yield* waitChange({ ...resolution, spec })
			if (Option.isNone(next) || update === undefined) return restart
			const candidate = next.value
			if (
				candidate.plugin !== spec.plugin ||
				candidate.revision !== spec.revision
			)
				return restart
			yield* TxRef.set(processing, candidate)
			const operation = Effect.suspend(() =>
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- The activation supplies decoding requirements; the owned fiber retains its complete Exit.
				spec.plugin.decode(candidate.input),
			).pipe(Effect.flatMap(update), inActivation(running.context, spec))
			const handled = yield* cancelOnChange(
				operation,
				waitChange({ ...resolution, spec: candidate }),
				(result, settled, _restore, expectedCancellation) =>
					Effect.gen(function* () {
						if (Exit.isFailure(result)) {
							// Teardown owns failures during cancellation; ordinary update failures are logged before restarting.
							if (
								!expectedCancellation(result.cause) &&
								(Exit.isFailure(settled) || Cause.hasInterrupts(result.cause))
							)
								yield* Ref.update(running.updateCleanup, (cause) =>
									Cause.combine(cause, result.cause),
								)
							if (
								!expectedCancellation(result.cause) ||
								(Exit.isSuccess(settled) && !settled.value)
							)
								yield* Effect.logWarning(
									"Updating in place failed; restarting instead",
									result.cause,
								).pipe(
									Effect.annotateLogs({
										"graft.fork": id,
										"graft.plugin": spec.plugin.name,
									}),
								)
						}
						if (Exit.isFailure(settled))
							return yield* Effect.failCause(settled.cause)
						return !settled.value && Exit.isSuccess(result) && result.value
					}),
			)
			if (!handled) return restart
			spec = candidate
			yield* setState(runtime, id, status, ForkState.Active(), spec)
		}
	})

	/** Every phase finishes before the immutable result is handed to state or disposal. */
	const teardown = Effect.fnUntraced(
		function* (running: Running, exit: Exit.Exit<unknown, unknown>) {
			const closer = yield* Effect.withFiber((self) => Effect.succeed(self.id))
			yield* Fiber.interrupt(running.fiber)
			const stopped = yield* Fiber.await(running.fiber)
			const withdrawn = yield* Effect.exit(
				withdraw(runtime, running.activation),
			)
			// Leased services may need these workers during consumer finalization.
			// Unmarked interruptions have unresolved attribution; retain their full causes.
			const tasksClosed = yield* Effect.exit(
				Finalization.close(running.tasks.scope, exit),
			)
			const closed = yield* Effect.exit(Finalization.close(running.scope, exit))
			const released = yield* Effect.exit(
				Effect.tx(
					Generations.settle(runtime, node, running.activation.generation),
				),
			)
			const tasks = yield* Ref.get(running.tasks.cleanupFailures)
			const updates = yield* Ref.get(running.updateCleanup)
			// Only the closer's cancellation of apply is expected here.
			const stoppedCause =
				Exit.isFailure(stopped) && !interruptedBy(stopped.cause, closer)
					? stopped.cause
					: Cause.empty
			const cause = Array.reduce(
				[withdrawn, tasksClosed, closed, released],
				Cause.combine(Cause.combine(tasks, updates), stoppedCause),
				(cause, result) =>
					Exit.isFailure(result) ? Cause.combine(cause, result.cause) : cause,
			)
			if (Exit.isFailure(closed))
				yield* Effect.logError(
					"Releasing the plugin's resources failed",
					closed.cause,
				)
			yield* reportFailure(
				`Plugin "${running.resolution.spec.plugin.name}" failed`,
				stopped,
			)
			return cause.reasons.length === 0 ? Exit.void : Exit.failCause(cause)
		},
		(effect, running) =>
			Effect.annotateLogs(effect, {
				"graft.fork": id,
				"graft.plugin": running.resolution.spec.plugin.name,
			}),
	)

	const waitRetry = Effect.fnUntraced(function* (
		outcome: Data.TaggedEnum.Value<Outcome, "Failed">,
		previous: Option.Option<Retry>,
	) {
		const { spec } = outcome.resolution
		// Publishing Failed transfers ownership of the result before cancellation can reach the idle supervisor.
		yield* Effect.uninterruptible(
			setState(
				runtime,
				id,
				status,
				ForkState.Failed({ cause: outcome.cause }),
				spec,
			).pipe(Effect.andThen(Ref.set(cleanup, Exit.void))),
		)

		const changed = Effect.asVoid(waitChange(outcome.resolution))
		const blocked = Array.flatMap(outcome.cause.reasons, (reason) =>
			reason._tag === "Fail" &&
			Schema.is(ServiceConflict)(reason.error) &&
			reason.error.fork === id &&
			(reason.error.reason === "SelfDependency" ||
				reason.error.reason === "DependencyCycle")
				? [realmKey(reason.error.realm ?? "", reason.error.service)]
				: [],
		)
		if (blocked.length > 0) {
			yield* Effect.acquireUseRelease(
				Effect.tx(Effect.forEach(blocked, (key) => Slots.retain(runtime, key))),
				(slots) => {
					const publishable = Effect.tx(
						Effect.gen(function* () {
							if ((yield* TxRef.get(specRef)) !== spec) return
							const resolution = yield* resolveCurrent(
								outcome.resolution.prepared,
							)
							if (resolution.missing.length > 0) return yield* Effect.txRetry
							const candidate = {
								watch: resolution.watch,
								provisions: resolution.provisions,
							}
							for (const slot of slots) {
								if (
									(yield* TxRef.get(slot.provision))._tag === "Some" ||
									(yield* publicationCycle(node, slot.key, candidate))
								)
									return yield* Effect.txRetry
							}
						}),
					)
					return Effect.raceFirst(changed, publishable)
				},
				(slots) =>
					Effect.tx(
						Effect.forEach(slots, (slot) => Slots.release(runtime, slot), {
							discard: true,
						}),
					),
			)
			return Option.none<Retry>()
		}
		if (spec.plugin.retry === undefined) {
			yield* changed
			return Option.none<Retry>()
		}
		const schedule = spec.plugin.retry
		const operation = Effect.gen(function* () {
			const step =
				Option.isSome(previous) &&
				sameAttempt(previous.value.resolution, outcome.resolution)
					? previous.value.step
					: yield* Schedule.toStepWithSleep(schedule)
			return yield* step(outcome.cause).pipe(
				Effect.as(Option.some({ resolution: outcome.resolution, step })),
				Pull.catchDone(() => Effect.succeedNone),
			)
		})
		return yield* cancelOnChange(
			operation,
			changed,
			(result, settled, restore, expectedCancellation) =>
				Effect.gen(function* () {
					if (Exit.isFailure(settled)) {
						// Disposal owns failures produced while cancelling the retry, not the already published startup failure.
						if (Exit.isFailure(result) && !expectedCancellation(result.cause))
							yield* Ref.set(cleanup, result)
						return yield* Effect.failCause(settled.cause)
					}
					if (
						Exit.isFailure(result) &&
						(!settled.value || !expectedCancellation(result.cause))
					) {
						yield* setState(
							runtime,
							id,
							status,
							ForkState.Failed({
								cause: Cause.combine(outcome.cause, result.cause),
							}),
							spec,
						)
					}
					if (settled.value) return Option.none<Retry>()
					if (Exit.isSuccess(result) && Option.isSome(result.value))
						return result.value
					yield* restore(changed)
					return Option.none<Retry>()
				}),
			(result) =>
				reportFailure("The plugin's retry schedule failed", result).pipe(
					Effect.annotateLogs({
						"graft.fork": id,
						"graft.plugin": spec.plugin.name,
					}),
				),
		)
	})

	// Mask acquisition, teardown, and result handoff together. Only plugin execution is interruptible.
	const cycle = Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const heldPermit = yield* Ref.get(permit)
			if (Option.isSome(lifecycle) && Option.isNone(heldPermit)) {
				const term = yield* restore(lifecycle.value.acquire)
				yield* Ref.set(permit, Option.some(term))
			}
			const acquired = yield* acquire
			if (acquired._tag === "Missing")
				return yield* restore(pending(acquired.resolution))
			const running = acquired.running
			yield* Ref.set(permit, Option.none())
			const used = yield* Effect.exit(
				restore(
					Effect.raceFirst(
						run(running),
						// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- The activation erases worker error types; teardown retains every full Cause.
						FiberSet.join(running.tasks.fibers).pipe(
							Effect.andThen(Effect.never),
							Effect.catchCause((cause) =>
								Effect.gen(function* () {
									const spec = yield* TxRef.get(processing)
									return Outcome.Failed({
										resolution: { ...running.resolution, spec },
										cause,
									})
								}),
							),
						),
					),
				),
			)
			if (Option.isSome(lifecycle) && Exit.isSuccess(used))
				yield* lifecycle.value.failed(
					used.value._tag === "Failed"
						? used.value.cause
						: Cause.fail("A captured local dependency changed"),
				)
			const cleaned = yield* teardown(
				running,
				Exit.isSuccess(used) && used.value._tag === "Failed"
					? Exit.failCause(used.value.cause)
					: used,
			)
			// An apply that interrupted itself is a failed attempt, unlike interruption requested by teardown.
			const closed =
				Exit.isSuccess(used) &&
				used.value._tag === "Failed" &&
				Cause.hasInterruptsOnly(used.value.cause) &&
				Exit.isFailure(cleaned)
					? Exit.failCause(Cause.combine(used.value.cause, cleaned.cause))
					: cleaned
			yield* Ref.set(cleanup, closed)
			const tasks = yield* Ref.get(running.tasks.failures)
			if (Option.isSome(lifecycle)) {
				if (tasks.reasons.length > 0) yield* lifecycle.value.failed(tasks)
				yield* lifecycle.value.stopped(closed)
			}
			if (Exit.isFailure(used)) {
				if (tasks.reasons.length > 0)
					yield* Ref.set(
						cleanup,
						Exit.failCause(
							Cause.combine(
								tasks,
								Exit.isFailure(closed) ? closed.cause : Cause.empty,
							),
						),
					)
				return yield* Effect.failCause(used.cause)
			}
			if (Exit.isFailure(closed)) {
				const spec = yield* TxRef.get(processing)
				return Outcome.Failed({
					resolution: { ...running.resolution, spec },
					cause: Cause.combine(
						Cause.combine(closed.cause, tasks),
						used.value._tag === "Failed" ? used.value.cause : Cause.empty,
					),
				})
			}
			return used.value._tag === "Failed"
				? Outcome.Failed({
						...used.value,
						cause: Cause.combine(used.value.cause, tasks),
					})
				: used.value
		}),
	)

	const loop = (previous: Option.Option<Retry>): Effect.Effect<void> =>
		cycle.pipe(
			Effect.flatMap((outcome) =>
				outcome._tag === "Failed"
					? waitRetry(outcome, previous)
					: Effect.succeedNone,
			),
			Effect.flatMap(loop),
		)
	yield* loop(Option.none()).pipe(
		Effect.ensuring(
			Effect.tx(
				Effect.gen(function* () {
					const remaining = yield* TxRef.get(held)
					if (remaining === undefined) return
					for (const slot of HashMap.values(remaining.slots))
						yield* Slots.release(runtime, slot)
				}),
			),
		),
	)
})
