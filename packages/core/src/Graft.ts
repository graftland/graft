/**
 * The graft runtime: loading plugins, publishing services, replacing
 * plugins at runtime, and observing the fork tree and its logs.
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
	Schema,
	Scope,
	Stream,
	TxPubSub,
	TxQueue,
	TxRef,
	TxSubscriptionRef,
} from "effect"

import { CleanupError, ForkState, type Fork, type ForkTree } from "./Fork"
import { setState, supervise, withdraw } from "./internal/activation"
import * as Aliases from "./internal/aliases"
import { inheritContext } from "./internal/context"
import { publicationCycle, resolutionChanged } from "./internal/dependencies"
import * as ForkStatus from "./internal/forkState"
import * as Generations from "./internal/generations"
import * as Probes from "./internal/probes"
import * as Replacement from "./internal/replacement"
import {
	GraftKey,
	realmKey,
	realmOf,
	Realms,
	type Activation,
	type ForkEntry,
	type ForkStatus as ForkStatusHandle,
	type GraphNode,
	type Handler,
	type LocalSnapshot,
	type LogEntry,
	type Provision,
	type Runtime,
	type ServiceKey,
	type Slot,
	type Spec,
} from "./internal/runtime"
import { RuntimeContext } from "./internal/runtimeContext"
import { ownedScope } from "./internal/scope"
import * as Slots from "./internal/slots"
import * as Snapshots from "./internal/snapshot"
import * as Coordinator from "./internal/transition"
import * as TrustState from "./internal/trust"
import type { ErrorOf, InputOf, Plugin } from "./Plugin"
import type * as Transition from "./Transition"

/** Identifies the current runtime. Use the module's operations to access it; its state is private. */
export class Graft extends Context.Service<Graft, unknown>()(GraftKey) {}

export class ServiceConflict extends Schema.TaggedError<
	ServiceConflict,
	{ readonly brand: unique symbol }
>()("ServiceConflict", {
	service: Schema.String,
	/** Absent for an existing provision; otherwise explains why this activation cannot publish. */
	reason: Schema.optionalKey(
		Schema.Literals(["SelfDependency", "DependencyCycle", "Invalidated"]),
	),
	realm: Schema.optionalKey(Schema.String),
	fork: Schema.optionalKey(Schema.Finite),
}) {
	override get message(): string {
		return this.reason === undefined
			? `Service "${this.service}" is already provided in this realm`
			: this.reason === "Invalidated"
				? `Cannot provide "${this.service}": the provider's dependencies have changed`
				: `Cannot provide "${this.service}": publication would restart its own provider`
	}
}

/**
 * Publishes a service into the current realm. It stays available until the
 * activation that published it is torn down, which first waits for every
 * consumer to let go of it.
 */
export const provide = Effect.fnUntraced(function* <I, S>(
	key: Context.Key<I, S>,
	value: S,
): Effect.fn.Return<void, ServiceConflict, Graft> {
	const { runtime, activation } = yield* RuntimeContext
	const realms = yield* Realms
	const qualified = realmKey(realmOf(realms, key.key), key.key)
	yield* Effect.tx(
		Effect.gen(function* () {
			const published = yield* TxRef.get(activation.published)
			if (Option.isNone(published)) {
				return yield* Effect.die(
					new Error(
						`Cannot provide "${key.key}": the plugin providing it is being torn down`,
					),
				)
			}
			const state = yield* TxRef.get(activation.node.state)
			const resolution = Option.getOrUndefined(
				HashMap.get(state.resolutions, activation.generation),
			)
			if (resolution !== undefined && (yield* resolutionChanged(resolution))) {
				return yield* ServiceConflict.make({
					service: key.key,
					reason: "Invalidated",
				})
			}
			// Retaining and publishing share the caller's transaction, including an outer Effect.tx.
			const directory = yield* TxRef.get(runtime.slots)
			const existing = HashMap.get(directory, qualified)
			if (
				Option.isSome(existing) &&
				(yield* TxRef.get(existing.value.provision))._tag === "Some"
			) {
				return yield* ServiceConflict.make({ service: key.key })
			}
			if (yield* publicationCycle(activation.node, qualified)) {
				const direct =
					resolution !== undefined && HashMap.has(resolution.watch, qualified)
				return yield* ServiceConflict.make({
					service: key.key,
					realm: realmOf(realms, key.key),
					fork: activation.fork,
					reason: direct ? "SelfDependency" : "DependencyCycle",
				})
			}
			const slot = yield* Slots.retain(runtime, qualified)
			const provision: Provision = {
				key: qualified,
				service: key.key,
				value,
				owner: activation.fork,
				generation: activation.generation,
				node: activation.node,
				slot,
				consumers: TxRef.makeUnsafe(HashSet.empty<Generations.Token>()),
			}
			yield* TxRef.set(slot.provision, Option.some(provision))
			yield* TxRef.set(
				activation.published,
				Option.some(Array.append(published.value, provision)),
			)
		}),
	)
})

export type { LogEntry } from "./internal/runtime"

/** How many log entries new subscribers of `logs` receive from the past. */
const logReplay = 1000

const runtimeLayer = Layer.effect(
	Graft,
	Effect.gen(function* () {
		const ambient = yield* Effect.context<never>()
		const forks = yield* Snapshots.make(HashMap.empty<number, ForkEntry>())
		const runtime: Runtime = {
			mutations: yield* TxRef.make(0),
			trust: yield* TxRef.make(TrustState.empty),
			transitionBusy: yield* TxRef.make(false),
			transitionStuck: yield* TxRef.make(false),
			ambient,
			slots: yield* TxRef.make(HashMap.empty<ServiceKey, Slot>()),
			forks,
			aliases: Aliases.make(),
			events: yield* TxRef.make(
				HashMap.empty<string, ReadonlyArray<Handler>>(),
			),
			ids: yield* TxRef.make(1),
			generationIds: yield* TxRef.make(1),
			logs: yield* PubSub.sliding<LogEntry>({
				capacity: logReplay,
				replay: logReplay,
			}),
		}
		const published = yield* TxRef.make(
			Option.some<ReadonlyArray<Provision>>([]),
		)
		const activation: Activation = {
			fork: 0,
			generation: new Generations.Token({ fork: 0, generation: 0 }),
			node: {
				id: 0,
				parent: undefined,
				state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
					live: true,
					resolutions: HashMap.empty(),
				}),
			},
			status: undefined,
			tasks: Option.none(),
			published,
			provisionKeys: HashSet.empty(),
			fallback: ambient,
		}
		yield* Effect.addFinalizer(() => withdraw(runtime, activation))
		return { runtime, activation }
	}),
)

/** Copies every log entry into the runtime, so `logs` can replay recent history. */
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

/** The root graft. Services provided at the root are withdrawn when the layer closes. */
export const layer: Layer.Layer<Graft> = Layer.provideMerge(
	loggerLayer,
	runtimeLayer,
)

/** An entry for `intercept`: adjusts a reference for one fork and everything below it. */
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

/** Anything resolved through realms: a service key or an event. */
export interface Isolatable {
	readonly key: string
}

export interface PluginOptions {
	/**
	 * Gives these services or events their own realm below this fork. A label
	 * puts every fork using it into one shared realm instead.
	 */
	readonly isolate?:
		ReadonlyArray<Isolatable | readonly [Isolatable, label: string]> | undefined
	readonly intercept?: ReadonlyArray<Intercept> | undefined
}

const isolation =
	(id: number) => (entry: Isolatable | readonly [Isolatable, string]) =>
		"key" in entry
			? ([entry.key, `#${id}`] as const)
			: ([entry[0].key, `@${entry[1]}`] as const)

/**
 * Changes a fork's spec and waits until its supervisor has acted on it:
 * updated in place, or begun restarting. A later change also counts.
 */
const accept = Effect.fnUntraced(function* (
	runtime: Runtime,
	id: number,
	status: ForkStatusHandle,
	spec: TxRef.TxRef<Spec>,
	f: (current: Spec) => Spec,
) {
	const next = yield* Effect.tx(
		Effect.gen(function* () {
			yield* Coordinator.check(runtime, id)
			return yield* TxRef.modify(spec, (current) => {
				const next = f(current)
				return [next, next]
			})
		}),
	)
	yield* Effect.tx(
		Effect.gen(function* () {
			const snapshot = yield* Snapshots.get(status.snapshot)
			if (snapshot.disposed || snapshot.accepted === next) return
			const current = yield* TxRef.get(spec)
			if (current !== next) return
			return yield* Effect.txRetry
		}),
	)
})

const makeFork = <I, E>(
	runtime: Runtime,
	status: ForkStatusHandle,
	id: number,
	spec: TxRef.TxRef<Spec>,
	dispose: Effect.Effect<void, CleanupError>,
): Fork<I, E> => {
	const snapshot = status.snapshot as Snapshots.Snapshot<
		LocalSnapshot<E | Schema.SchemaError>
	>
	const settled = (value: LocalSnapshot<E | Schema.SchemaError>) =>
		value.state._tag === "Failed"
			? Effect.failCause(value.state.cause)
			: Effect.void
	const state = Snapshots.changesStream(snapshot).pipe(
		// The definition's error bound is retained under compatible replacements.
		Stream.map(
			(snapshot) =>
				(
					snapshot as LocalSnapshot<
						E | Schema.SchemaError | Transition.ManagedFork
					>
				).state,
		),
		Stream.changes,
		Stream.takeUntil(ForkState.$is("Disposed")),
	)
	return {
		id,
		generations: TxSubscriptionRef.changesStream(status.generations),
		generationEvents: Stream.unwrap(
			Effect.map(TxPubSub.subscribe(status.generationEvents), (queue) =>
				Stream.fromEffectRepeat(TxQueue.take(queue)),
			),
		),
		probes: Probes.names(status.probes),
		probe: (name) => Probes.run(status.probes, name),
		state,
		await: Effect.flatMap(Snapshots.get(snapshot), (current) =>
			current.state._tag === "Loading"
				? Effect.flatMap(
						Snapshots.waitFor(
							snapshot,
							(value) => value.state._tag !== "Loading",
						),
						settled,
					)
				: settled(current),
		),
		stable: ForkStatus.stable(status),
		update: (input) =>
			accept(runtime, id, status, spec, (current) => ({ ...current, input })),
		restart: accept(runtime, id, status, spec, (current) => ({
			...current,
			revision: current.revision + 1,
		})),
		dispose,
	}
}

/** Loads a plugin under the current scope. Closing that scope unloads it. */
export const plugin: <P extends Plugin>(
	plugin: P,
	...args: [InputOf<P>] extends [void]
		? [input?: NoInfer<InputOf<P>>, options?: PluginOptions]
		: [input: NoInfer<InputOf<P>>, options?: PluginOptions]
) => Effect.Effect<Fork<InputOf<P>, ErrorOf<P>>, never, Graft | Scope.Scope> =
	Effect.fnUntraced(function* <P extends Plugin>(
		plugin: P,
		input?: InputOf<P>,
		options?: PluginOptions,
	) {
		// Publish the fork, install its cleanup, and start its supervisor atomically.
		// forkIn starts the supervisor interruptibly even while registration is masked.
		return yield* Effect.uninterruptible(
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
				const forkScope = owned.scope
				const { id, spec, node, status } = yield* Effect.acquireRelease(
					Effect.tx(
						Effect.gen(function* () {
							const id = yield* TxRef.get(runtime.ids)
							yield* TxRef.set(runtime.ids, id + 1)
							const resolved = yield* Aliases.resolve(runtime.aliases, plugin)
							const spec = TxRef.makeUnsafe<Spec>({
								plugin: resolved,
								requested: plugin,
								input,
								revision: 0,
							})
							const node: GraphNode = {
								id,
								parent: activation.node.id === 0 ? undefined : activation.node,
								state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
									live: true,
									resolutions: HashMap.empty(),
								}),
							}
							const initialSpec = yield* TxRef.get(spec)
							const status = yield* ForkStatus.make(
								activation.status,
								initialSpec,
							)
							const entry: ForkEntry = {
								initialRevision: initialSpec.revision,
								scope: forkScope,
								id,
								node,
								status,
								parent: activation.fork === 0 ? undefined : activation.fork,
								spec,
								accepted: undefined,
								name: resolved.name,
								input,
								state: ForkState.Loading(),
							}
							yield* Snapshots.update(runtime.forks, HashMap.set(id, entry))
							return { id, spec, node, status }
						}),
					),
					({ id, node, status }) =>
						Effect.tx(
							Effect.gen(function* () {
								yield* TxRef.update(node.state, (state) => ({
									...state,
									live: false,
								}))
								yield* ForkStatus.dispose(runtime, id, status)
							}),
						),
				).pipe(Scope.provide(forkScope))
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
									new Error("The plugin supervisor stopped unexpectedly"),
								),
							),
							Effect.catchCause((cause) =>
								Effect.gen(function* () {
									if (forkScope.state._tag === "Closed")
										return yield* Effect.failCause(cause)
									const cleanup = yield* Ref.get(termination)
									const completeCause = Exit.isFailure(cleanup)
										? Cause.combine(cause, cleanup.cause)
										: cause
									const attempted = yield* TxRef.get(processing)
									yield* Effect.logError(
										"The plugin supervisor failed",
										cause,
									).pipe(
										Effect.annotateLogs({
											"graft.fork": id,
											"graft.plugin": attempted.plugin.name,
										}),
									)
									yield* Effect.uninterruptible(
										setState(
											runtime,
											id,
											status,
											ForkState.Failed({ cause: completeCause }),
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
					Effect.forkIn(supervisor, forkScope),
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
												"Stopping the plugin supervisor failed",
												exit.cause,
											).pipe(Effect.annotateLogs({ "graft.fork": id })),
										),
									)
								: Effect.void
						}),
				).pipe(Scope.provide(forkScope))
				return makeFork<InputOf<P>, ErrorOf<P>>(
					runtime,
					status,
					id,
					spec,
					owned.close(Exit.void),
				)
			}),
		)
	})

export {
	ReplacementConflict,
	ReplacementFailure,
	ReplaceResult,
	type ReplaceOptions,
} from "./internal/replacement"

/** A plugin and the replacement `replace` swaps in for it. */
export type ReplacementPair = readonly [from: Plugin, to: Plugin]

/** Check every possible definition when either side is a union. */
export type CanReplace<
	From extends Plugin,
	To extends Plugin,
> = From extends Plugin
	? To extends Plugin
		? (<T>() => T extends InputOf<From> ? 1 : 2) extends <
				T,
			>() => T extends InputOf<To> ? 1 : 2
			? [ErrorOf<To>] extends [ErrorOf<From>]
				? true
				: false
			: false
		: false
	: false

/** A replacement pair whose input and error contracts are compatible. */
export type CompatibleReplacement<Pair extends ReplacementPair> =
	Pair extends readonly [infer From extends Plugin, infer To extends Plugin]
		? false extends CanReplace<From, To>
			? never
			: Pair
		: never

/** Each pair is checked independently; targets cannot widen the inferred source contract. */
export type CompatibleReplacements<
	Pairs extends ReadonlyArray<ReplacementPair>,
> = {
	readonly [Index in keyof Pairs]: CompatibleReplacement<Pairs[Index]>
}

/**
 * Swaps plugins for new versions. Every fork of an old plugin restarts with
 * its replacement, and loading the old plugin later loads the new one.
 * Each pair keeps the same input type and can only narrow the source's error bound.
 *
 * Then it waits for the forks running a replacement. If one fails, or
 * `timeout` passes first, forks still owned by this replacement go back to
 * the old plugins. After recovery settles, the result is `RolledBack` if no
 * counted restored fork failed, or `RecoveryFailed` otherwise. Both carry the
 * replacement `failures`; `RecoveryFailed.recovery` carries one `Failed` per
 * failed restored fork, with its full cause. Disposed forks and forks taken over by a later replacement or
 * restart no longer count. A `Pending` fork waiting for a dependency counts as
 * started or restored. Recovery is not bounded by `timeout`.
 * Interrupting the replacement wait keeps the swap.
 */
export const replace: <const Pairs extends ReadonlyArray<ReplacementPair>>(
	pairs: Pairs & CompatibleReplacements<NoInfer<Pairs>>,
	options?: Replacement.ReplaceOptions,
) => Effect.Effect<
	Replacement.ReplaceResult,
	Replacement.ReplacementConflict,
	Graft
> = Effect.fnUntraced(function* (
	pairs: ReadonlyArray<ReplacementPair>,
	options?: Replacement.ReplaceOptions,
) {
	const { runtime } = yield* RuntimeContext
	return yield* Replacement.replace(runtime, pairs, options)
})

/**
 * The plugin that loading `plugin` loads now: the plugin itself, or the one
 * that replacements have put in its place.
 */
export const resolve = (plugin: Plugin): Effect.Effect<Plugin, never, Graft> =>
	Effect.flatMap(RuntimeContext, ({ runtime }) =>
		Effect.tx(Aliases.resolve(runtime.aliases, plugin)),
	)

const byId = Order.mapInput(Order.Number, (entry: ForkEntry) => entry.id)

const buildTree = (
	forks: HashMap.HashMap<number, ForkEntry>,
): ReadonlyArray<ForkTree> => {
	// Group once: filtering every entry for each node would be quadratic, and
	// the tree is rebuilt on every fork change.
	const key = (parent: number | undefined) =>
		parent === undefined ? "" : `${parent}`
	const byParent = Array.groupBy(
		Array.sort(HashMap.toValues(forks), byId),
		(entry) => key(entry.parent),
	)
	const children = (parent: number | undefined): ReadonlyArray<ForkTree> =>
		Array.map(
			Record.get(byParent, key(parent)).pipe(
				Option.getOrElse((): ReadonlyArray<ForkEntry> => []),
			),
			(entry) => ({
				id: entry.id,
				name: entry.name,
				input: entry.input,
				state: entry.state,
				children: children(entry.id),
			}),
		)
	return children(undefined)
}

/** The fork tree, emitted again on every change. */
export const forks: Stream.Stream<
	ReadonlyArray<ForkTree>,
	never,
	Graft
> = Stream.unwrap(
	Effect.map(RuntimeContext, ({ runtime }) =>
		Snapshots.changesStream(runtime.forks).pipe(Stream.map(buildTree)),
	),
)

/** Recent and live environment logs, including host logs; plugin execution adds identity annotations. */
export const logs: Stream.Stream<LogEntry, never, Graft> = Stream.unwrap(
	Effect.map(RuntimeContext, ({ runtime }) => Stream.fromPubSub(runtime.logs)),
)

/** Runs one coordinator-owned transition. Unsupported targets return Aborted. */
export const transition: (
	request: Transition.Request,
) => Effect.Effect<Transition.Outcome, never, Graft> = (request) =>
	Coordinator.transition(request)
