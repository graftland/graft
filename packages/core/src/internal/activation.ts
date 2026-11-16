/**
 * The supervision loop of a single mount.
 *
 * Each iteration acquires the mount's dependencies, builds it in a fresh
 * activation, waits until the specification or a dependency changes, and
 * tears the activation down. Teardown follows a fixed order instead of
 * relying on finalizer registration order:
 *
 * 1. stop the build if it is still running;
 * 2. withdraw everything the activation published and close it to further
 *    publishing, so nobody new can lease it;
 * 3. wait until every consumer has released those provisions;
 * 4. stop supervised tasks and close their scopes, waiting for cleanup;
 * 5. close the activation scope (child mounts and resources);
 * 6. release the leases the activation itself holds, whatever happened before.
 *
 * All phases contribute to one cleanup Exit. Failed state or unmounting owns
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

import { Graft, ServiceConflict } from "../Graft"
import { MountState } from "../Mount"
import * as Release from "../Release"
import { isOptional } from "./definition"
import { publicationCycle, resolutionChanged } from "./dependencies"
import { setState } from "./mountStatus"
import {
	realmKey,
	realmOf,
	Realms,
	type Activation,
	type GraphNode,
	type MountStatus,
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
	/** The fiber building the mount; teardown stops it before withdrawing anything. */
	readonly fiber: Fiber.Fiber<void, unknown>
	readonly tasks: TaskGroup.Group
}

type Outcome = Data.TaggedEnum<{
	Restart: {}
	Failed: {
		readonly resolution: Resolution
		readonly cause: Cause.Cause<unknown>
	}
}>

const Outcome = Data.taggedEnum<Outcome>()

/** What acquiring a mount's dependencies produced. */
type Acquired = Data.TaggedEnum<{
	Missing: { readonly resolution: Resolution }
	Running: { readonly running: Running }
}>

const Acquired = Data.taggedEnum<Acquired>()

interface Retry {
	readonly resolution: Resolution
	readonly step: (
		input: unknown,
	) => Pull.Pull<Schedule.Metadata, never, unknown>
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
	readonly definition: Spec["definition"]
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

export { setState } from "./mountStatus"

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
				resolution:
					state.resolution === undefined
						? undefined
						: {
								...state.resolution,
								watch: HashMap.empty(),
							},
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
	/** The selected resolution, never a newer request still waiting in specRef. */
	processing: TxRef.TxRef<Spec>,
	node: GraphNode,
	status: MountStatus,
	completion?: Ref.Ref<Exit.Exit<void, unknown>>,
) {
	const cleanup =
		completion ?? (yield* Ref.make<Exit.Exit<void, unknown>>(Exit.void))
	const realms = yield* Realms
	/** What the mount inherits from where it was mounted: references and ambient services. */
	const inherited = yield* Effect.context<never>()
	const references = Context.merge(runtime.ambient, inherited)

	// A supervisor retains its handles through Pending, running, teardown, and failed retry.
	const held = yield* TxRef.make<Prepared | undefined>(undefined)
	const prepare = Effect.gen(function* () {
		const spec = yield* TxRef.get(specRef)
		const previous = yield* TxRef.get(held)
		if (previous?.definition === spec.definition) return previous
		let slots = HashMap.empty<ServiceKey, Slot>()
		const lookups = yield* Effect.forEach(
			spec.definition.requires,
			(dependency) =>
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
								Context.isReference(key) ? references : runtime.ambient,
								key,
							),
					}
				}),
		)
		if (previous !== undefined) {
			for (const slot of HashMap.values(previous.slots))
				yield* Slots.release(runtime, slot)
		}
		const prepared: Prepared = { definition: spec.definition, slots, lookups }
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
		const resolution = yield* Effect.tx(
			Effect.gen(function* () {
				const prepared = yield* prepare
				const resolution = yield* resolveCurrent(prepared)
				yield* TxRef.set(processing, resolution.spec)
				if (resolution.missing.length === 0) {
					for (const provision of resolution.provisions)
						yield* TxRef.update(provision.consumers, HashSet.add(id))
					yield* TxRef.update(node.state, (state) => ({
						...state,
						resolution: {
							watch: resolution.watch,
							provisions: resolution.provisions,
						},
					}))
				}
				return resolution
			}),
		)
		if (resolution.missing.length > 0) return Acquired.Missing({ resolution })
		const scope = yield* Scope.make()
		const tasks = yield* TaskGroup.make
		const published = yield* TxRef.make(
			Option.some<ReadonlyArray<Provision>>([]),
		)
		const activation: Activation = {
			mount: id,
			node,
			status,
			scope,
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
				...resolution.ambient,
				...Array.map(
					resolution.provisions,
					(provision) => [provision.service, provision.value] as const,
				),
				[Scope.Scope.key, scope],
				[Graft.key, { runtime, activation }],
			]),
		)
		const spec = resolution.spec
		yield* setState(runtime, id, status, MountState.Loading(), spec)
		const fiber = yield* Effect.suspend(() =>
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the activation discharges the mount's requirements and teardown observes its complete Exit
			spec.definition.apply(spec.input),
		).pipe(
			Effect.withSpan(`graft.mount ${spec.definition.name}`),
			inActivation(context, spec),
			Effect.forkIn(scope),
		)
		const running: Running = {
			resolution,
			tasks,
			activation,
			scope,
			fiber,
		}
		return Acquired.Running({ running })
	})

	const pending = Effect.fnUntraced(function* (resolution: Resolution) {
		yield* setState(
			runtime,
			id,
			status,
			MountState.Pending({ missing: resolution.missing }),
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

	/** Runs the build with the activation's context, which discharges whatever it requires. */
	const inActivation =
		(context: Context.Context<unknown>, spec: Spec) =>
		<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
			Effect.updateContext<A, E, unknown, never>(
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- this is where the mount's requirements are discharged
				Effect.annotateLogs(effect, {
					"graft.mount": id,
					"graft.name": spec.definition.name,
				}),
				() => context,
			)

	const run = Effect.fnUntraced(function* (running: Running) {
		const { resolution } = running
		const first = yield* Effect.raceFirst(
			Effect.asSome(Fiber.await(running.fiber)),
			Effect.as(waitChange(resolution), Option.none()),
		)
		if (Option.isNone(first)) return restart
		const exit = first.value
		if (exit._tag === "Failure")
			return Outcome.Failed({
				resolution,
				cause: exit.cause,
			})
		yield* setState(runtime, id, status, MountState.Active(), resolution.spec)
		yield* waitChange(resolution)
		return restart
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
			// Release.close marks independent interruptions; a pure interruption is pending cancellation.
			const tasksClosed = yield* Release.close(running.tasks.scope, exit).pipe(
				Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void),
				Effect.exit,
			)
			const closed = yield* Release.close(running.scope, exit).pipe(
				Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void),
				Effect.exit,
			)
			const released = yield* Effect.exit(
				Effect.tx(
					Effect.gen(function* () {
						for (const provision of running.resolution.provisions)
							yield* TxRef.update(provision.consumers, HashSet.remove(id))
						yield* TxRef.update(node.state, (state) => ({
							...state,
							resolution: undefined,
						}))
					}),
				),
			)
			const tasks = yield* Ref.get(running.tasks.failures)
			// Only the closer's cancellation of the build is expected here.
			const stoppedCause =
				Exit.isFailure(stopped) && !interruptedBy(stopped.cause, closer)
					? stopped.cause
					: Cause.empty
			const cause = Array.reduce(
				[withdrawn, tasksClosed, closed, released],
				Cause.combine(tasks, stoppedCause),
				(cause, result) =>
					Exit.isFailure(result) ? Cause.combine(cause, result.cause) : cause,
			)
			// A release that ends in a defect or a failure is reported. Pure cancellation
			// stays silent: interrupting a cleanup is how teardown itself unwinds.
			if (cause.reasons.length > 0 && !Cause.hasInterruptsOnly(cause))
				yield* Effect.logError("Releasing the mount's resources failed", cause)
			yield* reportFailure(
				`Mount "${running.resolution.spec.definition.name}" failed`,
				stopped,
			)
			return cause.reasons.length === 0 ? Exit.void : Exit.failCause(cause)
		},
		(effect, running) =>
			Effect.annotateLogs(effect, {
				"graft.mount": id,
				"graft.name": running.resolution.spec.definition.name,
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
				MountState.Failed({ cause: outcome.cause }),
				spec,
			).pipe(Effect.andThen(Ref.set(cleanup, Exit.void))),
		)

		const changed = Effect.asVoid(waitChange(outcome.resolution))
		const blocked = Array.flatMap(outcome.cause.reasons, (reason) =>
			reason._tag === "Fail" &&
			Schema.is(ServiceConflict)(reason.error) &&
			reason.error.mount === id &&
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
		if (spec.definition.retry === undefined) {
			yield* changed
			return Option.none<Retry>()
		}
		const schedule = spec.definition.retry
		const operation = Effect.gen(function* () {
			const step =
				Option.isSome(previous) &&
				sameAttempt(previous.value.resolution, outcome.resolution)
					? previous.value.step
					: yield* Schedule.toStepWithMetadata(schedule)
			return yield* step(outcome.cause).pipe(
				// A zero-duration step would rebuild without pause. Floor it so an
				// immediate schedule cannot spin the supervision loop; a step that
				// already asks for a delay is not changed.
				Effect.flatMap((meta) =>
					Duration.toMillis(meta.duration) > 0
						? Effect.void
						: Effect.sleep(Duration.millis(1)),
				),
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
							MountState.Failed({
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
				reportFailure("The mount's retry schedule failed", result).pipe(
					Effect.annotateLogs({
						"graft.mount": id,
						"graft.name": spec.definition.name,
					}),
				),
		)
	})

	// Mask acquisition, teardown, and result handoff together. Only the build is interruptible.
	const cycle = Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const acquired = yield* acquire
			if (acquired._tag === "Missing")
				return yield* restore(pending(acquired.resolution))
			const running = acquired.running
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
			const cleaned = yield* teardown(
				running,
				Exit.isSuccess(used) && used.value._tag === "Failed"
					? Exit.failCause(used.value.cause)
					: used,
			)
			// A build that interrupted itself is a failed attempt, unlike interruption requested by teardown.
			const closed =
				Exit.isSuccess(used) &&
				used.value._tag === "Failed" &&
				Cause.hasInterruptsOnly(used.value.cause) &&
				Exit.isFailure(cleaned)
					? Exit.failCause(Cause.combine(used.value.cause, cleaned.cause))
					: cleaned
			yield* Ref.set(cleanup, closed)
			if (Exit.isFailure(used)) return yield* Effect.failCause(used.cause)
			if (Exit.isFailure(closed)) {
				const spec = yield* TxRef.get(processing)
				return Outcome.Failed({
					resolution: { ...running.resolution, spec },
					cause: closed.cause,
				})
			}
			return used.value
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
