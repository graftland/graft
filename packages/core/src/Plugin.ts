/**
 * Plugins are the unit of composition. A plugin declares the services it
 * needs, decodes its configuration with a schema, and runs `apply` inside a
 * scope that lives exactly as long as the plugin is active.
 */
import type { Context, Schedule, Scope } from "effect"
import { Array as Arr, Effect, Layer, Option, Predicate, Schema } from "effect"
import { provide, type Graft, type ServiceConflict } from "./Graft"

const TypeId = "~@graftland/graft/Plugin"

/**
 * Marks a dependency as optional: the plugin starts without it and restarts
 * whenever it appears or disappears. Read it with `Effect.serviceOption`.
 */
export interface Optional<out Key extends Context.Key<any, any>> {
	readonly _tag: "Optional"
	readonly key: Key
}

export type Dependency = Context.Key<any, any> | Optional<Context.Key<any, any>>

/** Identifiers of the required dependencies in an `inject` list. */
export type Required<Inject extends ReadonlyArray<Dependency>> = Extract<
	Inject[number],
	Context.Key<any, any>
>["Identifier"]

/** Everything `apply` may require: its scope, the graft, and required dependencies. */
export type Requirements<Inject extends ReadonlyArray<Dependency>> =
	Scope.Scope | Graft | Required<Inject>

/**
 * Returned from `apply` to accept configuration changes in place. Resolving
 * to `false` restarts the plugin with the new configuration instead.
 */
export type Update<Config> = (next: Config) => Effect.Effect<boolean>

export interface Plugin<in out Config = any, in Input = any, out E = any> {
	readonly [TypeId]: typeof TypeId
	readonly name: string
	readonly inject: ReadonlyArray<Dependency>
	readonly retry: Schedule.Schedule<unknown, unknown> | undefined
	/** Runs only inside an activation, which provides whatever decoding needs. */
	readonly decode: (
		input: Input,
	) => Effect.Effect<Config, Schema.SchemaError, unknown>
	/** Runs only inside an activation, which provides whatever `apply` needs. */
	readonly apply: (
		config: Config,
	) => Effect.Effect<void | Update<Config>, E, unknown>
}

export const isPlugin = (u: unknown): u is Plugin =>
	Predicate.hasProperty(u, TypeId)

/** The plugin a module exports: its default export, or else an export named `plugin`. */
export const fromModule = (module: unknown): Option.Option<Plugin> =>
	Arr.findFirst(
		[
			Predicate.hasProperty(module, "default") ? module.default : undefined,
			Predicate.hasProperty(module, "plugin") ? module.plugin : undefined,
		],
		isPlugin,
	)

export const optional = <Key extends Context.Key<any, any>>(
	key: Key,
): Optional<Key> => ({ _tag: "Optional", key })

export const isOptional = (
	dependency: Dependency,
): dependency is Optional<Context.Key<any, any>> =>
	"_tag" in dependency && dependency._tag === "Optional"

interface Options<Inject extends ReadonlyArray<Dependency>> {
	readonly name: string
	readonly inject?: Inject | undefined
	/** Restarts a failed plugin on this schedule; without it, a failed plugin waits for a change. */
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
}

/**
 * Defines a plugin. `apply` may only require what `inject` declares as
 * required; anything else is a type error.
 */
export const make: {
	<const Inject extends ReadonlyArray<Dependency> = readonly [], E = never>(
		options: Options<Inject> & {
			readonly config?: undefined
			readonly apply: () => Effect.Effect<
				void | Update<void>,
				E,
				NoInfer<Requirements<Inject>>
			>
		},
	): Plugin<void, void, E>
	<
		S extends Schema.Top,
		const Inject extends ReadonlyArray<Dependency> = readonly [],
		E = never,
	>(
		options: Options<Inject> & {
			readonly config: S & {
				readonly DecodingServices: NoInfer<Requirements<Inject>>
			}
			readonly apply: (
				config: S["Type"],
			) => Effect.Effect<
				void | Update<S["Type"]>,
				E,
				NoInfer<Requirements<Inject>>
			>
		},
	): Plugin<S["Type"], S["Encoded"], E>
} = (
	options: Options<ReadonlyArray<Dependency>> & {
		readonly config?: Schema.Top | undefined
		readonly apply: (config: never) => Effect.Effect<unknown, unknown, unknown>
	},
): Plugin => {
	const schema = options.config
	return {
		[TypeId]: TypeId,
		name: options.name,
		inject: options.inject ?? [],
		retry: options.retry,
		decode: (schema === undefined
			? Effect.succeed
			: Schema.decodeUnknownEffect(schema)) as Plugin["decode"],
		apply: options.apply as Plugin["apply"],
	}
}

/**
 * Turns a layer into a plugin. Only the keys listed in `provides` are
 * published, and the layer is built from scratch on every activation.
 */
export const layer = <
	ROut,
	E,
	RIn extends Requirements<Inject>,
	const Inject extends ReadonlyArray<Dependency> = readonly [],
>(
	self: Layer.Layer<ROut, E, RIn>,
	options: Options<Inject> & {
		readonly provides: ReadonlyArray<Context.Key<ROut, any>>
	},
): Plugin<void, void, E | ServiceConflict> =>
	make({
		...options,
		apply: Effect.fnUntraced(function* () {
			const scope = yield* Effect.scope
			const memoMap = yield* Layer.makeMemoMap
			const context = yield* Layer.buildWithMemoMap(self, memoMap, scope)
			for (const key of options.provides)
				yield* provide(key, context.mapUnsafe.get(key.key))
		}),
	})

/** A plugin that builds one service with a scoped effect and publishes it. */
export const service = <
	I,
	S,
	E,
	R extends Requirements<Inject>,
	const Inject extends ReadonlyArray<Dependency> = readonly [],
>(
	key: Context.Key<I, S>,
	build: Effect.Effect<S, E, R>,
	options: Options<Inject>,
): Plugin<void, void, E | ServiceConflict> =>
	make({
		...options,
		apply: () => Effect.flatMap(build, (value) => provide(key, value)),
	})
