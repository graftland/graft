/**
 * The graft runtime: loading plugins, publishing services, replacing
 * plugins at runtime, and observing the fork tree and its logs.
 */
import {
	Array,
	Context,
	Cause,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Layer,
	Logger,
	Option,
	Result,
	Order,
	PubSub,
	References,
	Ref,
	Schema,
	Scope,
	Stream,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { CleanupError, ForkState, type Fork, type ForkTree } from "./Fork"
import { publicationCycle, resolutionChanged } from "./internal/dependencies"
import { PluginIdentity } from "./internal/pluginIdentity"
import { ownedScope } from "./internal/scope"
import { inheritContext } from "./internal/context"
import { supervise, setState, withdraw } from "./internal/activation"
import {
	Realms,
	realmKey,
	realmOf,
	type Activation,
	type ActiveResolution,
	type ForkEntry,
	type Handler,
	type LogEntry,
	type Provision,
	type Runtime,
	type ServiceKey,
	type Spec,
} from "./internal/runtime"
import type { Plugin, InputOf, ErrorOf } from "./Plugin"

/**
 * The graft a piece of code runs in: the shared runtime plus the activation
 * that owns anything it publishes.
 */
export class Graft extends Context.Service<
	Graft,
	{ readonly runtime: Runtime; readonly activation: Activation }
>()("@graftland/graft/Graft") {}

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
) {
	const { runtime, activation } = yield* Graft
	const realms = yield* Realms
	const provision: Provision = {
		key: realmKey(realmOf(realms, key.key), key.key),
		service: key.key,
		value,
		owner: activation.fork,
		consumers: TxRef.makeUnsafe(HashSet.empty<number>()),
	}
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
			const registry = yield* TxRef.get(runtime.registry)
			const active = yield* TxRef.get(runtime.active)
			if (
				Option.exists(HashMap.get(active, activation.fork), (resolution) =>
					resolutionChanged(resolution, registry),
				)
			) {
				return yield* ServiceConflict.make({
					service: key.key,
					reason: "Invalidated",
				})
			}
			if (HashMap.has(registry, provision.key)) {
				return yield* ServiceConflict.make({ service: key.key })
			}
			if (yield* publicationCycle(runtime, activation.fork, provision.key)) {
				const direct = Option.exists(
					HashMap.get(active, activation.fork),
					(resolution) => HashSet.has(resolution.watch, provision.key),
				)
				return yield* ServiceConflict.make({
					service: key.key,
					realm: realmOf(realms, key.key),
					fork: activation.fork,
					reason: direct ? "SelfDependency" : "DependencyCycle",
				})
			}
			yield* TxRef.set(
				runtime.registry,
				HashMap.set(registry, provision.key, provision),
			)
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
		const runtime: Runtime = {
			ambient,
			registry: yield* TxRef.make(HashMap.empty<ServiceKey, Provision>()),
			active: yield* TxRef.make(HashMap.empty<number, ActiveResolution>()),
			forks: yield* TxSubscriptionRef.make(HashMap.empty<number, ForkEntry>()),
			aliases: yield* TxRef.make(HashMap.empty<PluginIdentity, Plugin>()),
			events: yield* TxRef.make(
				HashMap.empty<string, ReadonlyArray<Handler>>(),
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
		const activation: Activation = {
			fork: 0,
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
		Effect.map(Graft, ({ runtime }) =>
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

/** Aliases are kept flat (no alias points at an aliased plugin), so one lookup suffices. */
const resolveAlias = (
	aliases: HashMap.HashMap<PluginIdentity, Plugin>,
	plugin: Plugin,
): Plugin =>
	Option.getOrElse(
		HashMap.get(aliases, new PluginIdentity(plugin)),
		() => plugin,
	)

const addAlias = (
	aliases: HashMap.HashMap<PluginIdentity, Plugin>,
	from: Plugin,
	to: Plugin,
): HashMap.HashMap<PluginIdentity, Plugin> => {
	// The replacement is live from now on, so it is never an alias itself.
	const redirected = HashMap.map(
		HashMap.remove(aliases, new PluginIdentity(to)),
		(current) => (current === from ? to : current),
	)
	return from === to
		? redirected
		: HashMap.set(redirected, new PluginIdentity(from), to)
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
const accept = (
	runtime: Runtime,
	id: number,
	spec: TxRef.TxRef<Spec>,
	f: (current: Spec) => Spec,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const next = yield* TxRef.modify(spec, (current) => {
			const next = f(current)
			return [next, next]
		})
		yield* Effect.tx(
			Effect.gen(function* () {
				const forks = yield* TxSubscriptionRef.get(runtime.forks)
				const entry = HashMap.get(forks, id)
				if (Option.isNone(entry) || entry.value.accepted === next) return
				const current = yield* TxRef.get(spec)
				if (current !== next) return
				return yield* Effect.txRetry
			}),
		)
	})

const makeFork = <I, E>(
	runtime: Runtime,
	id: number,
	spec: TxRef.TxRef<Spec>,
	dispose: Effect.Effect<void, CleanupError>,
): Fork<I, E> => {
	const state = TxSubscriptionRef.changesStream(runtime.forks).pipe(
		Stream.map((forks) => {
			// The shared registry erases entry types; this ID keeps its definition's bound under compatible replacement.
			const entry = HashMap.get(forks, id) as Option.Option<
				ForkEntry<E | Schema.SchemaError>
			>
			return Option.match(entry, {
				onNone: () => ForkState.Disposed(),
				onSome: (entry) => entry.state,
			})
		}),
		Stream.changes,
		Stream.takeUntil(ForkState.$is("Disposed")),
	)
	return {
		id,
		state,
		await: state.pipe(
			Stream.filter((state) => !ForkState.$is("Loading")(state)),
			Stream.runHead,
			Effect.flatMap((state) =>
				Option.isSome(state) && state.value._tag === "Failed"
					? Effect.failCause(state.value.cause)
					: Effect.void,
			),
		),
		update: (input) =>
			accept(runtime, id, spec, (current) => ({ ...current, input })),
		restart: accept(runtime, id, spec, (current) => ({
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
				const { runtime, activation } = yield* Graft
				const scope = yield* Effect.scope
				const termination = yield* Ref.make<Exit.Exit<void, unknown>>(Exit.void)
				const owned = yield* ownedScope(
					scope,
					Effect.flatMap(Ref.get(termination), (exit) =>
						Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
							? Effect.fail(CleanupError.make({ cause: exit.cause }))
							: Effect.void,
					),
				)
				const forkScope = owned.scope
				const { id, spec } = yield* Effect.acquireRelease(
					Effect.tx(
						Effect.gen(function* () {
							const id = yield* TxRef.get(runtime.ids)
							yield* TxRef.set(runtime.ids, id + 1)
							const aliases = yield* TxRef.get(runtime.aliases)
							const resolved = resolveAlias(aliases, plugin)
							const spec = TxRef.makeUnsafe<Spec>({
								plugin: resolved,
								input,
								revision: 0,
							})
							const entry: ForkEntry = {
								id,
								parent: activation.fork === 0 ? undefined : activation.fork,
								spec,
								accepted: undefined,
								name: resolved.name,
								input,
								state: ForkState.Loading(),
							}
							yield* TxSubscriptionRef.update(
								runtime.forks,
								HashMap.set(id, entry),
							)
							return { id, spec }
						}),
					),
					({ id }) =>
						TxSubscriptionRef.update(runtime.forks, HashMap.remove(id)),
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
								supervise(runtime, id, spec, processing, termination).pipe(
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
				).pipe(
					Effect.onExit((exit) =>
						Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
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
							: Effect.void,
					),
					Effect.updateContext<never, never>(() => context),
				)
				yield* Effect.forkIn(supervisor, forkScope)
				return makeFork<InputOf<P>, ErrorOf<P>>(
					runtime,
					id,
					spec,
					owned.close(Exit.void),
				)
			}),
		)
	})

/** The requested identities cannot be represented by the runtime's flat aliases. */
export class ReplacementConflict extends Schema.TaggedError<
	ReplacementConflict,
	{ readonly brand: unique symbol }
>()("ReplacementConflict", {
	indices: Schema.Array(Schema.Int),
}) {}

/** A plugin and the replacement `replace` swaps in for it. */
export type ReplacementPair = readonly [from: Plugin, to: Plugin]

type SameInput<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? true
		: false

/** Check every possible definition when either side is a union. */
type CanReplace<From extends Plugin, To extends Plugin> = From extends Plugin
	? To extends Plugin
		? SameInput<InputOf<From>, InputOf<To>> extends true
			? [ErrorOf<To>] extends [ErrorOf<From>]
				? true
				: false
			: false
		: false
	: false

type CompatibleReplacement<Pair extends ReplacementPair> =
	Pair extends readonly [infer From extends Plugin, infer To extends Plugin]
		? false extends CanReplace<From, To>
			? never
			: Pair
		: never

/** Each pair is checked independently; targets cannot widen the inferred source contract. */
type CompatibleReplacements<Pairs extends ReadonlyArray<ReplacementPair>> = {
	readonly [Index in keyof Pairs]: CompatibleReplacement<Pairs[Index]>
}

/**
 * Swaps plugins for new versions. Every fork of an old plugin restarts with
 * its replacement, and loading the old plugin later loads the new one.
 * Each pair keeps the same input type and can only narrow the source's error bound.
 */
export const replace: <const Pairs extends ReadonlyArray<ReplacementPair>>(
	pairs: Pairs & CompatibleReplacements<NoInfer<Pairs>>,
) => Effect.Effect<void, ReplacementConflict, Graft> = Effect.fnUntraced(
	function* (pairs: ReadonlyArray<ReplacementPair>) {
		const { runtime } = yield* Graft
		yield* Effect.tx(
			Effect.gen(function* () {
				const current = yield* TxRef.get(runtime.aliases)
				const aliases = Array.reduce(pairs, current, (aliases, [from, to]) =>
					addAlias(aliases, from, to),
				)
				// Validate against the same snapshot we commit. Both existing forks and
				// future imports must resolve to the requested target, independent of order.
				const conflicts = Array.filterMap(pairs, ([from, to], index) => {
					const overlap =
						from !== to &&
						Array.some(
							pairs,
							([other, target]) =>
								other !== target && (to === other || from === target),
						)
					const inconsistent =
						resolveAlias(aliases, from) !== to ||
						resolveAlias(aliases, resolveAlias(current, from)) !== to ||
						resolveAlias(aliases, to) !== to
					return overlap || inconsistent
						? Result.succeed(index)
						: Result.fail(undefined)
				})
				if (conflicts.length > 0)
					return yield* ReplacementConflict.make({ indices: conflicts })
				yield* TxRef.set(runtime.aliases, aliases)
				const forks = yield* TxSubscriptionRef.get(runtime.forks)
				for (const entry of HashMap.values(forks)) {
					const spec = yield* TxRef.get(entry.spec)
					const next = resolveAlias(aliases, spec.plugin)
					if (next !== spec.plugin) {
						yield* TxRef.set(entry.spec, {
							...spec,
							plugin: next,
							revision: spec.revision + 1,
						})
					}
				}
			}),
		)
	},
)

const byId = Order.mapInput(Order.Number, (entry: ForkEntry) => entry.id)

const buildTree = (
	forks: HashMap.HashMap<number, ForkEntry>,
): ReadonlyArray<ForkTree> => {
	const entries = Array.sort(HashMap.toValues(forks), byId)
	const children = (parent: number | undefined): ReadonlyArray<ForkTree> =>
		Array.map(
			Array.filter(entries, (entry) => entry.parent === parent),
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
	Effect.map(Graft, ({ runtime }) =>
		TxSubscriptionRef.changesStream(runtime.forks).pipe(Stream.map(buildTree)),
	),
)

/** Recent and live environment logs, including host logs; plugin execution adds identity annotations. */
export const logs: Stream.Stream<LogEntry, never, Graft> = Stream.unwrap(
	Effect.map(Graft, ({ runtime }) => Stream.fromPubSub(runtime.logs)),
)
