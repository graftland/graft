/**
 * Dynamic layers for Effect. Mount a layer, and Graft builds it while
 * everything it requires is available, publishes the services it provides,
 * and tears it down, dependents first, when a requirement goes away.
 */
import {
	Array,
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Logger,
	Option,
	Order,
	PubSub,
	Record,
	Ref,
	References,
	Scope,
	Stream,
	TxRef,
	TxSubscriptionRef,
	type Schedule,
} from "effect"

import { setState, supervise, withdraw } from "./internal/activation"
import { ServiceConflict, ServiceWithdrawn } from "./internal/conflicts"
import { inheritContext } from "./internal/context"
import {
	Optional,
	type Definition,
	type Dependency,
} from "./internal/definition"
import * as MountRegistry from "./internal/mountStatus"
import { ensureOpen, publishValue } from "./internal/publication"
import {
	GraftKey,
	realmKey,
	realmOf,
	Realms,
	type Activation,
	type GraphNode,
	type LocalSnapshot,
	type LogEntry,
	type MountEntry,
	type MountStatus,
	type Provision,
	type Runtime,
	type ServiceKey,
	type Slot,
	type Spec,
} from "./internal/runtime"
import { RuntimeContext } from "./internal/runtimeContext"
import { ownedScope } from "./internal/scope"
import * as Slots from "./internal/slots"
import * as TaskGroup from "./internal/tasks"
import type { Tasks } from "./internal/tasks"
import {
	CleanupError,
	MountState,
	type Mount,
	type MountTree,
	type Publication,
} from "./Mount"

export type { Dependency, Optional } from "./internal/definition"
export type { LogEntry } from "./internal/runtime"
export type { Tasks } from "./internal/tasks"

/** Identifies the current graph. Use the module's operations to access it; its state is private. */
export class Graft extends Context.Service<Graft, unknown>()(GraftKey) {}

export { ServiceConflict, ServiceWithdrawn } from "./internal/conflicts"

/**
 * Marks a requirement as optional: the mount builds without it and rebuilds
 * whenever it appears or disappears. Read it with `Effect.serviceOption`.
 */
export const optional = <Key extends Context.Key<any, any>>(
	key: Key,
): Optional<Key> => new Optional({ key })

/**
 * Identifiers of the required entries in a `requires` list. Optional entries do
 * not count: the layer is built while they may be absent, so it must read them
 * through `Effect.serviceOption`.
 */
export type Required<Requires extends ReadonlyArray<Dependency>> = Extract<
	Requires[number],
	Context.Key<any, any>
>["Identifier"]

/** The errors of background fibers started with `Graft.fork`. */
export type BackgroundError<R> = R extends Tasks<infer E> ? E : never

/** How many log entries new subscribers of `logs` receive from the past. */
const logReplay = 1000

const runtimeLayer = Layer.effect(
	Graft,
	Effect.gen(function* () {
		const ambient = yield* Effect.context<never>()
		const runtime: Runtime = {
			ambient,
			slots: yield* TxRef.make(HashMap.empty<ServiceKey, Slot>()),
			mounts: yield* TxSubscriptionRef.make(
				HashMap.empty<number, MountEntry>(),
			),
			ids: yield* TxRef.make(1),
			logs: yield* PubSub.sliding<LogEntry>({
				capacity: logReplay,
				replay: logReplay,
			}),
		}
		const published = yield* TxRef.make(
			Option.some<ReadonlyArray<Provision>>([]),
		)
		const scope = yield* Effect.scope
		const activation: Activation = {
			mount: 0,
			node: {
				id: 0,
				parent: undefined,
				state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
					live: true,
					resolution: undefined,
				}),
			},
			status: undefined,
			scope,
			tasks: Option.none(),
			published,
			provisionKeys: HashSet.empty(),
			fallback: ambient,
		}
		yield* Effect.addFinalizer(() => withdraw(runtime, activation))
		return { runtime, activation }
	}),
)

/** Copies every log entry into the graph, so `logs` can replay recent history. */
const loggerLayer = Logger.layer(
	[
		Effect.map(RuntimeContext, ({ runtime }) =>
			Logger.make((options) => {
				PubSub.publishUnsafe(runtime.logs, {
					date: options.date,
					level: options.logLevel,
					message: options.message,
					cause: options.cause,
					annotations: options.fiber.getRef(References.CurrentLogAnnotations),
				})
			}),
		),
	],
	{ mergeWithExisting: true },
)

/**
 * The graph. Services in the environment it is built in satisfy `requires`
 * too. Closing the layer unmounts everything.
 */
export const layer: Layer.Layer<Graft> = Layer.provideMerge(
	loggerLayer,
	runtimeLayer,
)

/** An entry for `intercept`: adjusts a reference for one mount and everything below it. */
export interface Intercept {
	readonly apply: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>
}

export const intercept = <A>(
	reference: Context.Reference<A>,
	// The value type comes from the reference alone; a callback returning anything else is an error there.
	f: (outer: A) => NoInfer<A>,
): Intercept => ({
	apply: (effect) => Effect.updateService(effect, reference, f),
})

/** Anything resolved through realms, such as a service key. */
export interface Isolatable {
	readonly key: string
}

/** Where a mount's services are visible, and what it inherits. */
export interface PlacementOptions {
	/**
	 * Gives these services their own realm below this mount. A label puts
	 * every mount using it into one shared realm instead.
	 */
	readonly isolate?:
		ReadonlyArray<Isolatable | readonly [Isolatable, label: string]> | undefined
	readonly intercept?: ReadonlyArray<Intercept> | undefined
}

export interface MountOptions<
	Requires extends ReadonlyArray<Dependency>,
> extends PlacementOptions {
	/** Shown in the mount tree and in log annotations. */
	readonly name?: string | undefined
	/**
	 * What the layer needs from the graph. The layer is built only while every
	 * required entry is available, and rebuilt when any of them changes.
	 */
	readonly requires?: Requires | undefined
	/** Rebuilds a failed mount on this schedule; without it, a failed mount waits for a change. */
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
}

const isolation =
	(id: number) => (entry: Isolatable | readonly [Isolatable, string]) =>
		"key" in entry
			? ([entry.key, `#${id}`] as const)
			: ([entry[0].key, `@${entry[1]}`] as const)

/**
 * Changes a mount's spec and waits until its supervisor has acted on it:
 * rebuilding has begun. A later change also counts.
 */
const accept = Effect.fnUntraced(function* (
	status: MountStatus,
	spec: TxRef.TxRef<Spec>,
	f: (current: Spec) => Spec,
) {
	const next = yield* TxRef.modify(spec, (current) => {
		const next = f(current)
		return [next, next]
	})
	yield* Effect.tx(
		Effect.gen(function* () {
			const snapshot = yield* TxSubscriptionRef.get(status.snapshot)
			if (snapshot.disposed || snapshot.accepted === next) return
			const current = yield* TxRef.get(spec)
			if (current !== next) return
			return yield* Effect.txRetry
		}),
	)
})

interface Started {
	readonly id: number
	readonly status: MountStatus
	readonly spec: TxRef.TxRef<Spec>
	readonly unmount: Effect.Effect<void, CleanupError>
}

const makeMount = <E>({ id, status, spec, unmount }: Started): Mount<E> => {
	const state = TxSubscriptionRef.changesStream(status.snapshot).pipe(
		// The definition's error type is carried by the public signature.
		Stream.map((snapshot) => (snapshot as LocalSnapshot<E>).state),
		Stream.changes,
		Stream.takeUntil(MountState.$is("Unmounted")),
	)
	return {
		id,
		state,
		await: state.pipe(
			Stream.filter((state) => !MountState.$is("Loading")(state)),
			Stream.runHead,
			Effect.flatMap((state) =>
				Option.isSome(state) && state.value._tag === "Failed"
					? Effect.failCause(state.value.cause)
					: Effect.void,
			),
		),
		stable: MountRegistry.stable(status),
		restart: accept(status, spec, (current) => ({
			...current,
			revision: current.revision + 1,
		})),
		unmount,
	}
}

/** Registers a mount, ties it to the current scope, and starts its supervisor. */
const start = (
	definition: Definition,
	input: unknown,
	options: PlacementOptions | undefined,
	/**
	 * A publication belongs to the mount it is published from: it may not be
	 * registered once that mount is tearing down, and it is torn down with it.
	 */
	publishes = false,
): Effect.Effect<Started, never, Graft | Scope.Scope> =>
	// Register the mount, install its cleanup, and start its supervisor atomically.
	// forkIn starts the supervisor interruptibly even while registration is masked.
	Effect.uninterruptible(
		Effect.gen(function* () {
			const { runtime, activation } = yield* RuntimeContext
			const scope = yield* Effect.scope
			const termination = yield* Ref.make<Exit.Exit<void, unknown>>(Exit.void)
			const owned = yield* ownedScope(
				scope,
				Effect.flatMap(Ref.get(termination), (exit) =>
					Exit.isFailure(exit)
						? Effect.fail(CleanupError.make({ cause: exit.cause }))
						: Effect.void,
				),
			)
			const mountScope = owned.scope
			// Whoever unmounts this mount closes the activation that owns it, even
			// when the caller passed an independent scope.
			if (publishes)
				yield* Scope.addFinalizerExit(activation.scope, (exit) =>
					owned.close(exit).pipe(Effect.orDie),
				)
			const { id, spec, node, status } = yield* Effect.acquireRelease(
				Effect.tx(
					Effect.gen(function* () {
						// The check shares this transaction with the registration below:
						// teardown closing the owner either happens before this reads it,
						// or after this mount is registered. There is no window between,
						// because this body never suspends.
						if (publishes) yield* ensureOpen(activation, definition.name)
						const id = yield* TxRef.get(runtime.ids)
						yield* TxRef.set(runtime.ids, id + 1)
						const spec = TxRef.makeUnsafe<Spec>({
							definition,
							input,
							revision: 0,
						})
						const node: GraphNode = {
							id,
							parent: activation.node.id === 0 ? undefined : activation.node,
							state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
								live: true,
								resolution: undefined,
							}),
						}
						const initialSpec = yield* TxRef.get(spec)
						const status = yield* MountRegistry.make(
							activation.status,
							initialSpec,
						)
						const entry: MountEntry = {
							id,
							node,
							status,
							parent: activation.mount === 0 ? undefined : activation.mount,
							spec,
							accepted: undefined,
							name: definition.name,
							input,
							state: MountState.Loading(),
						}
						yield* TxSubscriptionRef.update(
							runtime.mounts,
							HashMap.set(id, entry),
						)
						return { id, spec, node, status }
					}),
				),
				({ id, node, status }) =>
					Effect.tx(
						Effect.gen(function* () {
							yield* TxRef.set(node.state, {
								live: false,
								resolution: undefined,
							})
							yield* MountRegistry.dispose(runtime, id, status)
						}),
					),
			).pipe(Scope.provide(mountScope))
			const realms = HashMap.fromIterable(
				Array.map(options?.isolate ?? [], isolation(id)),
			)
			const inherited = yield* Effect.context<never>()
			const context = inheritContext(activation, inherited)
			const supervisor = Effect.forever(
				Effect.gen(function* () {
					const initial = yield* TxRef.get(spec)
					const processing = yield* TxRef.make(initial)
					yield* Effect.suspend(() =>
						Array.reduce(
							options?.intercept ?? [],
							supervise(
								runtime,
								id,
								spec,
								processing,
								node,
								status,
								termination,
							).pipe(
								Effect.updateService(Realms, (outer) =>
									HashMap.union(outer, realms),
								),
							),
							(effect, entry) => entry.apply(effect),
						),
					).pipe(
						Effect.andThen(
							Effect.die(
								new Error("The mount supervisor stopped unexpectedly"),
							),
						),
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								if (mountScope.state._tag === "Closed")
									return yield* Effect.failCause(cause)
								const cleanup = yield* Ref.get(termination)
								const completeCause = Exit.isFailure(cleanup)
									? Cause.combine(cause, cleanup.cause)
									: cause
								const attempted = yield* TxRef.get(processing)
								yield* Effect.logError(
									"The mount supervisor failed",
									cause,
								).pipe(
									Effect.annotateLogs({
										"graft.mount": id,
										"graft.name": attempted.definition.name,
									}),
								)
								yield* Effect.uninterruptible(
									setState(
										runtime,
										id,
										status,
										MountState.Failed({ cause: completeCause }),
										attempted,
									).pipe(Effect.andThen(Ref.set(termination, Exit.void))),
								)
								yield* Effect.tx(
									Effect.gen(function* () {
										const current = yield* TxRef.get(spec)
										if (current === attempted) return yield* Effect.txRetry
									}),
								)
							}),
						),
					)
				}),
			).pipe(Effect.updateContext<never, never>(() => context))
			yield* Effect.acquireRelease(
				Effect.forkIn(supervisor, mountScope),
				(fiber) =>
					Effect.gen(function* () {
						const closer = yield* Effect.withFiber((self) =>
							Effect.succeed(self.id),
						)
						yield* Fiber.interrupt(fiber)
						const exit = yield* Fiber.await(fiber)
						// Only our cancellation is expected; an interceptor finalizer can interrupt itself.
						return yield* Exit.isFailure(exit) &&
						!Array.every(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === closer,
						)
							? Ref.update(termination, (cleanup) =>
									Exit.failCause(
										Exit.isFailure(cleanup)
											? Cause.combine(cleanup.cause, exit.cause)
											: exit.cause,
									),
								).pipe(
									Effect.andThen(
										Effect.logError(
											"Stopping the mount supervisor failed",
											exit.cause,
										).pipe(Effect.annotateLogs({ "graft.mount": id })),
									),
								)
							: Effect.void
					}),
			).pipe(Scope.provide(mountScope))
			return { id, status, spec, unmount: owned.close(Exit.void) }
		}),
	)

/**
 * Mounts a layer under the current scope; closing that scope unmounts it.
 *
 * The layer is built while every required entry of `requires` is available,
 * and each service it outputs is published to the graph. When a requirement
 * changes, mounts that use this layer's services are torn down first, then
 * the layer is released and built again. Effect's internal
 * `Layer.CurrentMemoMap` is never published, even if the layer outputs it.
 *
 * When the layer fails to build and a finalizer of that build also dies,
 * Effect reports both as defects, so the typed build failure appears as a
 * `Die`.
 */
export const mount = <
	ROut,
	E,
	RIn extends Required<Requires> | Graft | Tasks<any>,
	const Requires extends ReadonlyArray<Dependency> = readonly [],
>(
	self: Layer.Layer<ROut, E, RIn>,
	options?: MountOptions<Requires>,
): Effect.Effect<
	Mount<E | BackgroundError<RIn> | ServiceConflict>,
	never,
	Graft | Scope.Scope
> =>
	Effect.map(
		start(
			{
				name: options?.name ?? "layer",
				requires: options?.requires ?? [],
				retry: options?.retry,
				apply: () =>
					Effect.gen(function* () {
						const scope = yield* Effect.scope
						const memoMap = yield* Layer.makeMemoMap
						const context = yield* Layer.buildWithMemoMap(self, memoMap, scope)
						// `buildWithMemoMap` adds its own memo map to the result; it is
						// infrastructure, not a service this layer provides.
						for (const [service, value] of Context.omit(Layer.CurrentMemoMap)(
							context,
						).mapUnsafe)
							yield* publishValue(service, value)
					}),
			},
			undefined,
			options,
		),
		(started) => makeMount<E | BackgroundError<RIn> | ServiceConflict>(started),
	)

/**
 * Publishes a value under the current scope; closing that scope withdraws
 * it. `set` replaces the value, which rebuilds everything that requires it.
 * A publication from inside a mount also ends with that mount, and is
 * refused once that mount has begun tearing down.
 */
export const publish = <I, S>(
	key: Context.Key<I, S>,
	value: S,
	options?: PlacementOptions,
): Effect.Effect<Publication<S, ServiceConflict>, never, Graft | Scope.Scope> =>
	Effect.gen(function* () {
		const { activation } = yield* RuntimeContext
		const started = yield* start(
			{
				name: key.key,
				requires: [],
				retry: undefined,
				apply: (input) => publishValue(key.key, input, activation),
			},
			value,
			options,
			true,
		)
		return {
			...makeMount<ServiceConflict>(started),
			set: (value: S) =>
				accept(started.status, started.spec, (current) => ({
					...current,
					input: value,
				})),
		}
	})

/**
 * Starts a fiber owned by the current mount. It is interrupted when the mount
 * is torn down, and its failure fails the mount.
 */
export const fork: <A, E, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<
	Fiber.Fiber<A, E>,
	never,
	Exclude<R, Scope.Scope> | Graft | Tasks<E>
> = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
	const { activation } = yield* RuntimeContext
	if (Option.isNone(activation.tasks))
		return yield* Effect.die(new Error("Graft.fork requires a mounted layer"))
	return yield* TaskGroup.run(activation.tasks.value, effect)
})

/** Holds a slot so its identity survives while nothing is published in it. */
const retained = (key: string) =>
	Effect.gen(function* () {
		const { runtime } = yield* RuntimeContext
		const realms = yield* Realms
		const qualified = realmKey(realmOf(realms, key), key)
		return yield* Effect.acquireRelease(
			Effect.tx(Slots.retain(runtime, qualified)),
			(slot) => Effect.tx(Slots.release(runtime, slot)),
		)
	})

const sameProvision = (
	left: Option.Option<Provision>,
	right: Option.Option<Provision>,
) =>
	Option.isNone(left)
		? Option.isNone(right)
		: Option.isSome(right) && left.value === right.value

/** Waits until a provision is available, and holds it until released. */
const lease = (slot: Slot, consumer: number) =>
	Effect.acquireRelease(
		Effect.tx(
			Effect.gen(function* () {
				const current = yield* TxRef.get(slot.provision)
				if (Option.isNone(current)) return yield* Effect.txRetry
				yield* TxRef.update(current.value.consumers, HashSet.add(consumer))
				return current.value
			}),
		),
		(provision) =>
			Effect.tx(TxRef.update(provision.consumers, HashSet.remove(consumer))),
	)

/** Completes once this exact provision is no longer the one published. */
const withdrawn = (slot: Slot, provision: Provision) =>
	Effect.tx(
		Effect.gen(function* () {
			const current = yield* TxRef.get(slot.provision)
			if (Option.exists(current, (current) => current === provision))
				return yield* Effect.txRetry
		}),
	)

const consumerId = Effect.gen(function* () {
	const { runtime } = yield* RuntimeContext
	return yield* TxRef.modify(runtime.ids, (id) => [id, id + 1])
})

/**
 * The service's availability: `Some` while it is published, `None` while it
 * is not, followed by every change. Only services in the graph count, not the
 * environment `layer` was built in.
 */
export const watch = <I, S>(
	key: Context.Key<I, S>,
): Stream.Stream<Option.Option<S>, never, Graft> =>
	Stream.unwrap(
		Effect.map(retained(key.key), (slot) =>
			Stream.unfold(Option.none<Option.Option<Provision>>(), (previous) =>
				Effect.tx(
					Effect.gen(function* () {
						const current = yield* TxRef.get(slot.provision)
						if (
							Option.isSome(previous) &&
							sameProvision(previous.value, current)
						)
							return yield* Effect.txRetry
						return [
							Option.map(current, (provision) => provision.value as S),
							Option.some(current),
						] as const
					}),
				),
			),
		),
	)

/**
 * Waits until the service is published and returns it. The value may be
 * withdrawn right after; use `use` or `whileAvailable` to hold it.
 */
export const await_ = <I, S>(
	key: Context.Key<I, S>,
): Effect.Effect<S, never, Graft> =>
	Effect.scoped(
		Effect.flatMap(retained(key.key), (slot) =>
			Effect.tx(
				Effect.gen(function* () {
					const current = yield* TxRef.get(slot.provision)
					if (Option.isNone(current)) return yield* Effect.txRetry
					return current.value.value as S
				}),
			),
		),
	)
export { await_ as await }

/** Leases the service for one run of `f`, racing it against withdrawal. */
const leased = <I, S, A, E, R, A2, E2>(
	key: Context.Key<I, S>,
	f: (service: S) => Effect.Effect<A, E, R>,
	onWithdrawn: Effect.Effect<A2, E2>,
	repeat: boolean,
): Effect.Effect<A | A2, E | E2, R | Graft> =>
	Effect.gen(function* () {
		const scope = yield* Scope.make()
		return yield* Effect.gen(function* () {
			const slot = yield* Scope.provide(retained(key.key), scope)
			const once = Effect.gen(function* () {
				const leaseScope = yield* Scope.make()
				return yield* Effect.gen(function* () {
					const consumer = yield* consumerId
					const provision = yield* Scope.provide(
						lease(slot, consumer),
						leaseScope,
					)
					return yield* Effect.raceFirst(
						f(provision.value as S),
						Effect.andThen(withdrawn(slot, provision), onWithdrawn),
					)
				}).pipe(Effect.onExit((exit) => Scope.close(leaseScope, exit)))
			})
			if (!repeat) return yield* once
			return yield* Effect.forever(once)
		}).pipe(Effect.onExit((exit) => Scope.close(scope, exit)))
	})

/**
 * Waits until the service is published, then runs `f` with it. While `f`
 * runs, the provider waits before tearing the service down. If the service
 * is withdrawn first, `f` is interrupted and this fails with `ServiceWithdrawn`.
 */
export const use = <I, S, A, E, R>(
	key: Context.Key<I, S>,
	f: (service: S) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ServiceWithdrawn, R | Graft> =>
	leased(key, f, ServiceWithdrawn.make({ service: key.key }), false)

/**
 * Runs `f` whenever the service is published. When the service is withdrawn,
 * `f` is interrupted, and runs again with the next value. If `f` completes,
 * it waits for the next value; if it fails, this fails.
 */
export const whileAvailable = <I, S, E, R>(
	key: Context.Key<I, S>,
	f: (service: S) => Effect.Effect<void, E, R>,
): Effect.Effect<never, E, R | Graft> =>
	Effect.andThen(
		leased(
			key,
			(service) => Effect.andThen(f(service), Effect.never),
			Effect.void,
			true,
		),
		Effect.never,
	)

const byId = Order.mapInput(Order.Number, (entry: MountEntry) => entry.id)

const buildTree = (
	mounts: HashMap.HashMap<number, MountEntry>,
): ReadonlyArray<MountTree> => {
	// Group once: filtering every entry for each node would be quadratic, and
	// the tree is rebuilt on every change.
	const key = (parent: number | undefined) =>
		parent === undefined ? "" : `${parent}`
	const byParent = Array.groupBy(
		Array.sort(HashMap.toValues(mounts), byId),
		(entry) => key(entry.parent),
	)
	const children = (parent: number | undefined): ReadonlyArray<MountTree> =>
		Array.map(
			Record.get(byParent, key(parent)).pipe(
				Option.getOrElse((): ReadonlyArray<MountEntry> => []),
			),
			(entry) => ({
				id: entry.id,
				name: entry.name,
				state: entry.state,
				children: children(entry.id),
			}),
		)
	return children(undefined)
}

/** The mount tree, emitted again on every change. */
export const mounts: Stream.Stream<
	ReadonlyArray<MountTree>,
	never,
	Graft
> = Stream.unwrap(
	Effect.map(RuntimeContext, ({ runtime }) =>
		TxSubscriptionRef.changesStream(runtime.mounts).pipe(Stream.map(buildTree)),
	),
)

/** Recent and live logs; logs written while building a mount carry `graft.mount` and `graft.name`. */
export const logs: Stream.Stream<LogEntry, never, Graft> = Stream.unwrap(
	Effect.map(RuntimeContext, ({ runtime }) => Stream.fromPubSub(runtime.logs)),
)
