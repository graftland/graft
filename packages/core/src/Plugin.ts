/**
 * Plugins are the unit of composition. A plugin declares the services it
 * needs, decodes its configuration with a schema, and runs `apply` inside a
 * scope that lives exactly as long as the plugin is active.
 */
import {
	Array,
	Context,
	Data,
	Effect,
	Equal,
	HashSet,
	Layer,
	Option,
	Predicate,
	Schema,
	type Fiber,
	type Schedule,
	type Scope,
} from "effect"
import { identity } from "effect/Function"

import { Graft, provide, type ServiceConflict } from "./Graft"
import { RuntimeContext } from "./internal/runtimeContext"
import * as TaskGroup from "./internal/tasks"
import type { Tasks } from "./internal/tasks"

export type { Tasks } from "./internal/tasks"

/** Brands a plugin definition; `isPlugin` checks for it. */
export const TypeId = "~@graftland/graft/Plugin"
/** Keys the input and error contract that keeps a definition's types invariant. */
export const Contract = "~@graftland/graft/Plugin/Contract"

/**
 * Marks a dependency as optional: the plugin starts without it and restarts
 * whenever it appears or disappears. Read it with `Effect.serviceOption`.
 */
export class Optional<
	out Key extends Context.Key<any, any>,
> extends Data.TaggedClass("Optional")<{ readonly key: Key }> {}

export type Dependency = Context.Key<any, any> | Optional<Context.Key<any, any>>

/** An immutable protocol operation, independent of its transport and implementation. */
export const OperationIdentity = Schema.Struct({
	name: Schema.NonEmptyString.check(Schema.isPattern(/^\S+$/)),
	version: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type OperationIdentity = typeof OperationIdentity.Type

const operationKey = (identity: OperationIdentity) =>
	`${identity.name}@${identity.version}`

/** Exact operation-set compatibility; package versions and schemas are not compared. */
export type OperationComparison = Data.TaggedEnum<{
	Compatible: {}
	Incompatible: { readonly missing: ReadonlyArray<OperationIdentity> }
}>
const OperationComparison = Data.taggedEnum<OperationComparison>()

/** Checks whether the provider includes every required name and version. */
export const compareOperations = (
	required: ReadonlyArray<OperationIdentity>,
	provided: ReadonlyArray<OperationIdentity>,
): OperationComparison => {
	const available = HashSet.fromIterable(Array.map(provided, operationKey))
	const missing = Array.dedupeWith(
		Array.filter(
			required,
			(identity) => !HashSet.has(available, operationKey(identity)),
		),
		(left: OperationIdentity, right: OperationIdentity) =>
			left.name === right.name && left.version === right.version,
	)
	return missing.length === 0
		? OperationComparison.Compatible()
		: OperationComparison.Incompatible({ missing })
}

/** Structural contract metadata accepted from any public contract adapter. */
export interface ProvidedContract {
	readonly key: Context.Key<unknown, unknown>
	readonly operations: ReadonlyArray<OperationIdentity>
}

/** A local service key or a contract service declaration. */
export type Provided = Context.Key<any, any> | ProvidedContract

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
export type Update<Config, E = never, R = never> = (
	next: Config,
) => Effect.Effect<boolean, never, Graft | Scope.Scope | R | Tasks<E>>

/** Starts an activation-owned worker. Its unhandled errors belong to the plugin, not the launch operation. */
export const fork: <A, E, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<
	Fiber.Fiber<A, E>,
	never,
	Exclude<R, Scope.Scope> | Graft | Tasks<E>
> = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
	const { activation } = yield* RuntimeContext
	if (Option.isNone(activation.tasks))
		return yield* Effect.die(
			new Error("Plugin.fork requires a plugin activation"),
		)
	return yield* TaskGroup.run(activation.tasks.value, effect)
})

// A definition has one input/error contract even when referenced through aliases.
export type Plugin<Config = any, Input = any, E = any> = 0 extends 1 & Input
	? 0 extends 1 & E
		? Omit<Definition<Config, any, any>, typeof Contract> & {
				readonly [Contract]: unknown
			}
		: Definition<Config, Input, E | Schema.SchemaError>
	: Definition<Config, Input, E | Schema.SchemaError>

export interface Definition<in out Config, in out Input, in out E> {
	readonly [TypeId]: typeof TypeId
	readonly [Contract]: {
		readonly input: 0 extends 1 & Input ? unknown : (value: Input) => Input
		readonly error: 0 extends 1 & E ? unknown : (value: E) => E
	}
	readonly name: string
	/** The public configuration schema, when the plugin declares one. */
	readonly config: Schema.Top | undefined
	readonly inject: ReadonlyArray<Dependency>
	/** Declares exports; publishing still happens inside apply. */
	readonly provides: ReadonlyArray<Provided>
	/** Declares that serving may overlap another attempt; does not enable transitions. */
	readonly overlap: boolean
	readonly retry: Schedule.Schedule<unknown, unknown> | undefined
	/** Runs only inside an activation, which provides whatever decoding needs. */
	readonly decode: (
		input: Input,
	) => Effect.Effect<Config, Schema.SchemaError, unknown>
	/** Runs only inside an activation, which provides whatever `apply` needs. */
	readonly apply: (
		config: Config,
	) => Effect.Effect<void | Update<Config, E, unknown>, E, unknown>
}

/** The external configuration accepted by a definition, including dynamic definitions. */
export type InputOf<P extends Plugin> = Parameters<P["decode"]>[0]

/** The error bound carried by a definition. */
export type ErrorOf<P extends Plugin> = Effect.Error<ReturnType<P["apply"]>>

export const isPlugin = (u: unknown): u is Plugin =>
	Predicate.hasProperty(u, TypeId)

/** The plugin a module exports: its default export, or else an export named `plugin`. */
export const fromModule = (module: unknown): Option.Option<Plugin> =>
	Array.findFirst(
		[
			Predicate.hasProperty(module, "default") ? module.default : undefined,
			Predicate.hasProperty(module, "plugin") ? module.plugin : undefined,
		],
		isPlugin,
	)

export const optional = <Key extends Context.Key<any, any>>(
	key: Key,
): Optional<Key> => new Optional({ key })

export const isOptional = (
	dependency: Dependency,
): dependency is Optional<Context.Key<any, any>> =>
	"_tag" in dependency && dependency._tag === "Optional"

/** Options shared by `make`, `layer` and `service`. */
export interface Options<Inject extends ReadonlyArray<Dependency>> {
	/**
	 * Labels the plugin in logs, spans and the fork tree. Build it like an
	 * Effect service key: the package, the module path, then the binding unless
	 * it is the module's default export, such as `@acme/graft-plugin-db/migrations`.
	 */
	readonly name: string
	readonly inject?: Inject | undefined
	/** Describes the local services and contract operations this implementation provides. */
	readonly provides?: ReadonlyArray<Provided> | undefined
	/** Whether serving is safe alongside another attempt. Defaults to false. */
	readonly overlap?: boolean | undefined
	/** Restarts a failed plugin on this schedule; without it, a failed plugin waits for a change. */
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
}

/**
 * Defines a plugin. `apply` may only require what `inject` declares as
 * required; anything else is a type error.
 */
export const make: {
	<
		const Inject extends ReadonlyArray<Dependency> = readonly [],
		E = never,
		Background = never,
	>(
		options: Options<Inject> & {
			readonly config?: undefined
			readonly apply: () => Effect.Effect<
				void | Update<void, Background, Required<Inject>>,
				E,
				NoInfer<Requirements<Inject>> | Tasks<Background>
			>
		},
	): Definition<void, void, E | Background | Schema.SchemaError>
	<
		S extends Schema.Top,
		const Inject extends ReadonlyArray<Dependency> = readonly [],
		E = never,
		Background = never,
	>(
		options: Options<Inject> & {
			readonly config: S & {
				readonly DecodingServices:
					NoInfer<Requirements<Inject>> | Tasks<Background>
			}
			readonly apply: (
				config: S["Type"],
			) => Effect.Effect<
				void | Update<S["Type"], Background, Required<Inject>>,
				E,
				NoInfer<Requirements<Inject>> | Tasks<Background>
			>
		},
	): Definition<S["Type"], S["Encoded"], E | Background | Schema.SchemaError>
} = (
	options: Options<ReadonlyArray<Dependency>> & {
		readonly config?: Schema.Top | undefined
		readonly apply: (config: never) => Effect.Effect<unknown, unknown, unknown>
	},
) => {
	const schema = options.config
	// Factory results also compare by reference in caller-owned Effect collections.
	// The runtime uses its own identity keys, so copied definitions are supported too.
	return Equal.byReference({
		[TypeId]: TypeId,
		[Contract]: { input: identity, error: identity },
		name: options.name,
		config: schema,
		inject: options.inject ?? [],
		provides: options.provides ?? [],
		overlap: options.overlap ?? false,
		retry: options.retry,
		// Overloads connect the schema's decoded type to the callback; this implementation erases that type.
		decode: (schema === undefined
			? Effect.succeed
			: Schema.decodeUnknownEffect(schema)) as Plugin["decode"],
		// The public overload already checked that apply accepts the schema's output and declares its errors.
		apply: options.apply as Plugin["apply"],
	} satisfies Plugin)
}

/**
 * Turns a layer into a plugin. Only the keys listed in `provides` are
 * published, and the layer is built from scratch on every activation.
 */
export const layer = <
	ROut,
	E,
	RIn extends Requirements<Inject> | Tasks<any>,
	const Inject extends ReadonlyArray<Dependency> = readonly [],
>(
	self: Layer.Layer<ROut, E, RIn>,
	options: Options<Inject> & {
		readonly provides: ReadonlyArray<Context.Key<ROut, any>>
	},
): Plugin<
	void,
	void,
	E | (RIn extends Tasks<infer Error> ? Error : never) | ServiceConflict
> =>
	make({
		...options,
		apply: Effect.fnUntraced(function* () {
			const scope = yield* Effect.scope
			const memoMap = yield* Layer.makeMemoMap
			const context = yield* Layer.buildWithMemoMap(self, memoMap, scope)
			for (const key of options.provides)
				yield* provide(key, Context.get(context, key))
		}),
	})

/** A plugin that builds one service with a scoped effect and publishes it. */
export const service = <
	I,
	S,
	E,
	R extends Requirements<Inject> | Tasks<any>,
	const Inject extends ReadonlyArray<Dependency> = readonly [],
>(
	key: Context.Key<I, S>,
	build: Effect.Effect<S, E, R>,
	options: Options<Inject>,
): Plugin<
	void,
	void,
	E | (R extends Tasks<infer Error> ? Error : never) | ServiceConflict
> =>
	make({
		...options,
		provides: options.provides ?? [key],
		apply: () => Effect.flatMap(build, (value) => provide(key, value)),
	})
