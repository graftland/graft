/**
 * Turns the `name` of an entry into a plugin.
 */
import { Plugin } from "@nmnmcc/graft"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Path,
	Predicate,
	Record,
	Schema,
	String as Str,
} from "effect"

export class ModuleNotFound extends Schema.TaggedError<
	ModuleNotFound,
	{ readonly brand: unique symbol }
>()("ModuleNotFound", {
	plugin: Schema.String,
	tried: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `No plugin found for "${this.plugin}" (tried ${Arr.join(this.tried, ", ")})`
	}
}

/** A module was found but importing it failed, or it exports no plugin. */
export class ModuleInvalid extends Schema.TaggedError<
	ModuleInvalid,
	{ readonly brand: unique symbol }
>()("ModuleInvalid", { specifier: Schema.String, cause: Schema.Unknown }) {
	override get message(): string {
		return `Module "${this.specifier}" could not be loaded as a plugin`
	}
}

export class ModuleResolver extends Context.Service<
	ModuleResolver,
	{
		readonly resolve: (
			name: string,
		) => Effect.Effect<Plugin.Plugin, ModuleNotFound | ModuleInvalid>
	}
>()("@nmnmcc/graft-loader/ModuleResolver") {}

const isPath = (name: string) =>
	Str.startsWith(".")(name) || Str.startsWith("/")(name)

/** The specifiers tried for a name, in order: as written, then the naming conventions for short names. */
export const candidates = (name: string): ReadonlyArray<string> =>
	isPath(name) || Str.includes(":")(name) || Str.startsWith("@")(name)
		? [name]
		: [name, `@nmnmcc/graft-plugin-${name}`, `graft-plugin-${name}`]

/** An error followed by its causes, outermost first. */
const causes = (error: unknown, depth = 0): ReadonlyArray<unknown> =>
	depth < 8 &&
	Predicate.hasProperty(error, "cause") &&
	error.cause !== undefined
		? [error, ...causes(error.cause, depth + 1)]
		: [error]

/** What a module resolution error says is missing, if it is one. */
const missingName = (error: unknown): Option.Option<string> =>
	Predicate.hasProperty(error, "code") &&
	error.code === "ERR_MODULE_NOT_FOUND" &&
	Predicate.hasProperty(error, "message") &&
	Predicate.isString(error.message)
		? Option.flatMap(
				Str.match(/Cannot find (?:package|module) '([^']+)'/)(error.message),
				(match) => Option.fromNullishOr(match[1]),
			)
		: Option.none()

/**
 * Whether an import failed because the candidate itself does not exist, as
 * opposed to something it imports. Only then is the next candidate tried.
 */
const isMissing = (error: unknown, candidate: ReadonlyArray<string>) =>
	Arr.some(causes(error), (error) =>
		Option.exists(missingName(error), (name) => Arr.contains(candidate, name)),
	)

/** The package a bare specifier belongs to: `@scope/name` or `name`. */
const packageOf = (specifier: string) =>
	Arr.join(
		Arr.take(Str.split("/")(specifier), Str.startsWith("@")(specifier) ? 2 : 1),
		"/",
	)

/**
 * Resolves names with dynamic `import`. Relative specifiers are resolved
 * against `base`; bare ones go through `importer`, which should run in the
 * application so its dependencies are visible.
 */
export const make = (options: {
	readonly base: string
	readonly importer: (specifier: string) => Promise<unknown>
}): Effect.Effect<(typeof ModuleResolver)["Service"], never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const absolute = (specifier: string) =>
			isPath(specifier)
				? Effect.map(
						path.toFileUrl(path.resolve(options.base, specifier)),
						(url) => url.href,
					)
				: Effect.succeed(specifier)
		/** The names Node may report for this candidate when it is missing. */
		const names = (specifier: string) =>
			isPath(specifier)
				? [specifier, path.resolve(options.base, specifier)]
				: [specifier, packageOf(specifier)]
		/** `None` when nothing exists under this specifier, so the next candidate is tried. */
		const attempt = (specifier: string) =>
			absolute(specifier).pipe(
				Effect.orElseSucceed(() => specifier),
				Effect.flatMap((url) =>
					Effect.tryPromise({
						try: () => options.importer(url),
						catch: (cause) => ModuleInvalid.make({ specifier, cause }),
					}),
				),
				Effect.flatMap((module) =>
					Effect.fromOption(Plugin.fromModule(module), () =>
						ModuleInvalid.make({ specifier, cause: "it exports no plugin" }),
					),
				),
				Effect.asSome,
				Effect.catchIf(
					(error) => isMissing(error.cause, names(specifier)),
					() => Effect.succeedNone,
				),
			)
		return {
			resolve: Effect.fnUntraced(function* (name: string) {
				const tried = candidates(name)
				for (const specifier of tried) {
					const plugin = yield* attempt(specifier)
					if (Option.isSome(plugin)) return plugin.value
				}
				return yield* ModuleNotFound.make({ plugin: name, tried })
			}),
		}
	})

export const layer = (
	options: Parameters<typeof make>[0],
): Layer.Layer<ModuleResolver, never, Path.Path> =>
	Layer.effect(ModuleResolver, make(options))

/** Resolves names from a fixed table, for tests and bundled applications. */
export const fromRecord = (
	plugins: Readonly<Record<string, Plugin.Plugin>>,
): Layer.Layer<ModuleResolver> =>
	Layer.succeed(ModuleResolver, {
		resolve: (name) =>
			Effect.fromOption(Record.get(plugins, name), () =>
				ModuleNotFound.make({ plugin: name, tried: [name] }),
			),
	})
