/**
 * The graft runtime: loading plugins, publishing services, replacing
 * plugins at runtime, and observing the fork tree and its logs.
 */
import type { Cause } from "effect"
import {
	Array as Arr,
	Context,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Layer,
	Logger,
	Option,
	Order,
	PubSub,
	References,
	Schema,
	Scope,
	Stream,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { ForkState, type Fork, type ForkTree } from "./Fork"
import { supervise, withdraw } from "./internal/activation"
import {
	Realms,
	realmKey,
	type Activation,
	type ForkEntry,
	type Handler,
	type LogEntry,
	type Provision,
	type Runtime,
	type Spec,
} from "./internal/runtime"
import type { Plugin } from "./Plugin"

/**
 * The graft a piece of code runs in: the shared runtime plus the activation
 * that owns anything it publishes.
 */
export class Graft extends Context.Service<
	Graft,
	{ readonly runtime: Runtime; readonly activation: Activation }
>()("@nmnmcc/graft/Graft") {}

export class ServiceConflict extends Schema.TaggedError<
	ServiceConflict,
	{ readonly brand: unique symbol }
>()("ServiceConflict", { service: Schema.String }) {
	override get message(): string {
		return `Service "${this.service}" is already provided in this realm`
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
		key: realmKey(realms, key.key),
		service: key.key,
		value,
		leases: TxRef.makeUnsafe(0),
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
			if (HashMap.has(registry, provision.key)) {
				return yield* ServiceConflict.make({ service: key.key })
			}
			yield* TxRef.set(
				runtime.registry,
				HashMap.set(registry, provision.key, provision),
			)
			yield* TxRef.set(
				activation.published,
				Option.some(Arr.append(published.value, provision)),
			)
			yield* TxRef.update(runtime.dynamic, HashSet.add(key.key))
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
			registry: yield* TxRef.make(HashMap.empty<string, Provision>()),
			forks: yield* TxSubscriptionRef.make(HashMap.empty<number, ForkEntry>()),
			aliases: yield* TxRef.make(HashMap.empty<Plugin, Plugin>()),
			dynamic: yield* TxRef.make(HashSet.empty<string>()),
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
		const activation: Activation = { fork: 0, published }
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
	f: (outer: A) => A,
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
	aliases: HashMap.HashMap<Plugin, Plugin>,
	plugin: Plugin,
): Plugin => Option.getOrElse(HashMap.get(aliases, plugin), () => plugin)

const addAlias = (
	aliases: HashMap.HashMap<Plugin, Plugin>,
	from: Plugin,
	to: Plugin,
): HashMap.HashMap<Plugin, Plugin> => {
	// The replacement is live from now on, so it is never an alias itself.
	const redirected = HashMap.map(HashMap.remove(aliases, to), (current) =>
		current === from ? to : current,
	)
	return from === to ? redirected : HashMap.set(redirected, from, to)
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
	scope: Scope.Closeable,
): Fork<I, E> => {
	const state = TxSubscriptionRef.changesStream(runtime.forks).pipe(
		Stream.map((forks) =>
			Option.match(HashMap.get(forks, id), {
				onNone: () => ForkState.Disposed(),
				onSome: (entry) => entry.state,
			}),
		),
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
					? Effect.failCause(
							state.value.cause as Cause.Cause<E | Schema.SchemaError>,
						)
					: Effect.void,
			),
		),
		update: (input) =>
			accept(runtime, id, spec, (current) => ({ ...current, input })),
		restart: accept(runtime, id, spec, (current) => ({
			...current,
			revision: current.revision + 1,
		})),
		dispose: Scope.close(scope, Exit.void),
	}
}

/** Loads a plugin under the current scope. Closing that scope unloads it. */
export const plugin: <C, I, E>(
	plugin: Plugin<C, I, E>,
	...args: [I] extends [void]
		? [input?: I, options?: PluginOptions]
		: [input: I, options?: PluginOptions]
) => Effect.Effect<Fork<I, E>, never, Graft | Scope.Scope> = Effect.fnUntraced(
	function* (plugin: Plugin, input?: unknown, options?: PluginOptions) {
		const { runtime, activation } = yield* Graft
		const scope = yield* Effect.scope
		const forkScope = yield* Scope.fork(scope)
		const { id, spec } = yield* Effect.tx(
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
				yield* TxSubscriptionRef.update(runtime.forks, HashMap.set(id, entry))
				return { id, spec }
			}),
		)
		yield* Scope.addFinalizer(
			forkScope,
			TxSubscriptionRef.update(runtime.forks, HashMap.remove(id)),
		)
		const realms = HashMap.fromIterable(
			Arr.map(options?.isolate ?? [], isolation(id)),
		)
		const supervisor = Arr.reduce(
			options?.intercept ?? [],
			supervise(runtime, id, spec).pipe(
				Effect.updateService(Realms, (outer) => HashMap.union(outer, realms)),
			),
			(effect, entry) => entry.apply(effect),
		)
		yield* Effect.forkIn(supervisor, forkScope)
		return makeFork(runtime, id, spec, forkScope)
	},
)

/**
 * Swaps plugins for new versions. Every fork of an old plugin restarts with
 * its replacement, and loading the old plugin later loads the new one.
 */
export const replace = Effect.fnUntraced(function* (
	pairs: ReadonlyArray<readonly [from: Plugin, to: Plugin]>,
) {
	const { runtime } = yield* Graft
	yield* Effect.tx(
		Effect.gen(function* () {
			const current = yield* TxRef.get(runtime.aliases)
			const aliases = Arr.reduce(pairs, current, (aliases, [from, to]) =>
				addAlias(aliases, from, to),
			)
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
})

const byId = Order.mapInput(Order.Number, (entry: ForkEntry) => entry.id)

const buildTree = (
	forks: HashMap.HashMap<number, ForkEntry>,
): ReadonlyArray<ForkTree> => {
	const entries = Arr.sort(HashMap.toValues(forks), byId)
	const children = (parent: number | undefined): ReadonlyArray<ForkTree> =>
		Arr.map(
			Arr.filter(entries, (entry) => entry.parent === parent),
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

/** Recent log entries followed by new ones, annotated with `graft.fork` and `graft.plugin`. */
export const logs: Stream.Stream<LogEntry, never, Graft> = Stream.unwrap(
	Effect.map(Graft, ({ runtime }) => Stream.fromPubSub(runtime.logs)),
)
