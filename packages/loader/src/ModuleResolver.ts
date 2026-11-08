/** Resolves transferable module descriptors; executable checks run in inspection units. */
import { isBuiltin, registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
	Array,
	Cause,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Predicate,
	Record,
	Result,
	Schema,
	Scope,
	Stream,
	String,
} from "effect"

import type { Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import { ConfigDirectory } from "./ConfigDirectory"
import { CurrentObservation } from "./internal/observation"

export class ModuleNotFound extends Schema.TaggedError<
	ModuleNotFound,
	{ readonly brand: unique symbol }
>()("ModuleNotFound", {
	plugin: Schema.String,
	tried: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `No plugin found for "${this.plugin}" (tried ${Array.join(this.tried, ", ")})`
	}
}

/**
 * A short name matched more than one installed package. Short names never
 * prefer one naming convention over another, so the entry must name the
 * package in full.
 */
export class AmbiguousPluginName extends Schema.TaggedError<
	AmbiguousPluginName,
	{ readonly brand: unique symbol }
>()("AmbiguousPluginName", {
	plugin: Schema.String,
	packages: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `"${this.plugin}" matches ${Array.join(this.packages, " and ")}; name the package in full`
	}
}

/** A module could not be imported, or plugin resolution found no plugin export. */
export class ModuleInvalid extends Schema.TaggedError<
	ModuleInvalid,
	{ readonly brand: unique symbol }
>()("ModuleInvalid", {
	specifier: Schema.String,
	cause: Schema.Unknown,
	reason: Schema.optionalKey(Schema.Literal("PluginExportMissing")),
	preparation: Schema.optionalKey(Schema.String),
}) {
	override get message(): string {
		return `Module "${this.specifier}" could not be loaded`
	}
}

/** An observed dependency remains outside the captured package closure. */
export const ExternalDependency = Schema.Struct({
	captured: Schema.Literal(false),
	requested: Schema.String,
	source: Schema.optionalKey(Schema.String),
	package: Schema.optionalKey(Schema.String),
	version: Schema.optionalKey(Schema.String),
})
export type ExternalDependency = typeof ExternalDependency.Type

export const Descriptor = Schema.Struct({
	kind: Schema.Literals(["Plugin", "Environment"]),
	artifact: Artifact.Artifact,
	location: Schema.String,
	base: Schema.String,
	export: Schema.Literals(["default", "plugin"]),
	suffix: Schema.String,
	externalDependencyCoverage: Schema.Literal("Declared"),
	externalDependencies: Schema.Record(Schema.String, ExternalDependency),
	provenance: Schema.Struct({
		specifier: Schema.String,
		source: Schema.String,
		package: Schema.optionalKey(Schema.String),
		version: Schema.optionalKey(Schema.String),
	}),
})
export type Descriptor = typeof Descriptor.Type

export class ModuleResolver extends Context.Service<
	ModuleResolver,
	{
		readonly resolve: (
			name: string,
			options?: ResolveOptions,
		) => Effect.Effect<
			Descriptor,
			ModuleNotFound | ModuleInvalid | AmbiguousPluginName,
			Scope.Scope
		>
	}
>()("@graftland/loader/ModuleResolver") {}

/** Selects the export role checked by disposable native inspection. */
export interface ResolveOptions {
	readonly kind?: "Plugin" | "Environment"
}
export const ResolverModule = Schema.Struct({
	artifact: Artifact.Artifact,
	options: Schema.Json,
})
export type ResolverModule = typeof ResolverModule.Type

export interface Options {
	readonly resolver?: ResolverModule
	readonly control: Control.Address
	readonly base: string
	readonly store?: string
	readonly placement?: "Worker" | "Process"
	readonly budget?: Partial<Kernel.Budget>
	/** Absolute paths never captured into artifacts, such as the config file that names the entries. */
	readonly uncaptured?: ReadonlyArray<string>
}
const isPath = (name: string) =>
	String.startsWith(".")(name) || String.startsWith("/")(name)
export const candidates = (name: string): ReadonlyArray<string> =>
	isPath(name) || String.includes(":")(name) || String.startsWith("@")(name)
		? [name]
		: [name, `@graftland/plugin-${name}`, `graft-plugin-${name}`]

const Package = Schema.Struct({
	optionalDependencies: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.String),
	),
	name: Schema.optionalKey(Schema.String),
	version: Schema.optionalKey(Schema.String),
	dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	peerDependencies: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.String),
	),
})
const packageAt = Effect.fnUntraced(function* (
	file: string,
): Effect.fn.Return<
	{ readonly directory: string; readonly metadata: typeof Package.Type },
	ModuleInvalid,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.dirname(file)
	const manifest = path.join(directory, "package.json")
	const exists = yield* fs
		.exists(manifest)
		.pipe(
			Effect.mapError((cause) =>
				ModuleInvalid.make({ specifier: file, cause }),
			),
		)
	if (exists) {
		const metadata = yield* fs.readFileString(manifest).pipe(
			Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Package))),
			Effect.catchCause((cause) =>
				ModuleInvalid.make({ specifier: file, cause }),
			),
		)
		return { directory, metadata }
	}
	if (path.dirname(directory) === directory)
		return yield* ModuleInvalid.make({
			specifier: file,
			cause: "A module must belong to a package with package.json",
		})
	return yield* packageAt(directory)
})

const missing = (error: unknown): boolean =>
	Predicate.hasProperty(error, "code") &&
	(error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")
/** Uses Node's import conditions and caller base without evaluating the resolved module. */
const locate = Effect.fnUntraced(function* (specifier: string, base: string) {
	if (isBuiltin(specifier))
		return yield* ModuleInvalid.make({
			specifier,
			cause: "Node built-ins do not export plugins",
			reason: "PluginExportMissing",
		})
	const prefix = `graft-module-descriptor:${base.length}:${base}:`
	const path = yield* Path.Path
	const requested = isPath(specifier)
		? pathToFileURL(path.resolve(base, specifier)).href
		: specifier
	return yield* Effect.acquireUseRelease(
		Effect.sync(() =>
			registerHooks({
				resolve: (name, context, next) =>
					String.startsWith(prefix)(name)
						? next(String.slice(prefix.length)(name), {
								...context,
								parentURL: pathToFileURL(base + "/package.json").href,
								conditions: ["node", "import", "module-sync", "node-addons"],
							})
						: next(name, context),
			}),
		),
		() =>
			Effect.try({
				try: () => import.meta.resolve(prefix + requested),
				catch: (cause) => ModuleInvalid.make({ specifier, cause }),
			}).pipe(
				Effect.asSome,
				Effect.catchIf(
					(error) => missing(error.cause),
					() => Effect.succeedNone,
				),
			),
		(hook) => Effect.sync(() => hook.deregister()),
	)
})

const externalInventory = Effect.fnUntraced(function* (
	metadata: typeof Package.Type,
	base: string,
) {
	const declarations = {
		...metadata.peerDependencies,
		...metadata.dependencies,
		...metadata.optionalDependencies,
	}
	const entries = yield* Effect.forEach(
		Record.toEntries(declarations),
		Effect.fnUntraced(function* ([name, requested]) {
			const dependency = ExternalDependency.make({ captured: false, requested })
			if (isBuiltin(name))
				return [
					name,
					{
						...dependency,
						source: String.startsWith("node:")(name) ? name : `node:${name}`,
					},
				] satisfies readonly [string, ExternalDependency]
			const located = yield* locate(name, base)
			if (Option.isNone(located))
				return [name, dependency] satisfies readonly [
					string,
					ExternalDependency,
				]
			if (!String.startsWith("file:")(located.value))
				return [
					name,
					{ ...dependency, source: located.value },
				] satisfies readonly [string, ExternalDependency]
			const file = yield* Effect.try({
				try: () => fileURLToPath(located.value),
				catch: (cause) => ModuleInvalid.make({ specifier: name, cause }),
			})
			const owner = yield* packageAt(file)
			return [
				name,
				ExternalDependency.make({
					...dependency,
					source: located.value,
					...(owner.metadata.name === undefined
						? {}
						: { package: owner.metadata.name }),
					...(owner.metadata.version === undefined
						? {}
						: { version: owner.metadata.version }),
				}),
			] satisfies readonly [string, ExternalDependency]
		}),
	)
	return Record.fromEntries(entries)
})

const inspectModule = Effect.fnUntraced(function* (
	kernel: Control.Client,
	artifact: Artifact.Artifact,
	suffix: string,
	options: Options,
	kind: "Plugin" | "Environment",
) {
	const target = Units.target({
		artifact,
		input: {},
		placement: options.placement ?? "Worker",
		inspection: "Module",
		...(kind === "Environment" ? { moduleKind: kind } : {}),
		moduleSuffix: suffix,
	})
	const status = yield* kernel.inspect({
		instance: `module:${artifact.identity.digest}`,
		target,
		...(options.budget === undefined ? {} : { budget: options.budget }),
	})
	if (
		Option.isNone(status.result) ||
		status.result.value._tag !== "Described" ||
		status.result.value.description.moduleExport === undefined
	)
		return yield* ModuleInvalid.make({
			specifier: artifact.identity.entry,
			cause: status.cause,
			preparation: status.id,
		})
	return status.result.value.description.moduleExport
})

const capture = Effect.fnUntraced(function* (
	kernel: Control.Client,
	source: string,
	specifier: string,
	base: string,
	options: Options,
	kind: "Plugin" | "Environment",
) {
	const path = yield* Path.Path
	const url = yield* Effect.try({
		try: () => new URL(source),
		catch: (cause) => ModuleInvalid.make({ specifier, cause }),
	})
	if (url.protocol !== "file:")
		return yield* ModuleInvalid.make({
			specifier,
			cause: "Only filesystem modules can be captured",
		})
	const file = yield* Effect.try({
		try: () => fileURLToPath(url),
		catch: (cause) => ModuleInvalid.make({ specifier, cause }),
	})
	const owner = yield* packageAt(file)
	const store = path.resolve(
		options.store ?? path.join(options.base, ".graft/artifacts"),
	)
	const files = yield* FileSystem.FileSystem
	/** Compare real paths: the owner directory is resolved, and temporary paths are often symbolic links. */
	const uncaptured = yield* Effect.forEach(
		options.uncaptured ?? [],
		(absolute) =>
			files.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute)),
	)
	const inside = (absolute: string) => {
		const relative = path.relative(owner.directory, absolute)
		return !path.isAbsolute(relative) &&
			!String.startsWith("../")(relative) &&
			relative !== ""
			? [relative]
			: []
	}
	/** Editing an uncaptured file, such as graft.yml, must not change every artifact of its package. */
	const exclude = [
		"node_modules",
		".git",
		".cache",
		".graft",
		...inside(store),
		...Array.flatMap(uncaptured, inside),
	]
	const artifact = yield* Artifact.capture({
		directory: owner.directory,
		entry: path.relative(owner.directory, file),
		store,
		exclude,
	}).pipe(
		Effect.catchCause((cause) => ModuleInvalid.make({ specifier, cause })),
	)
	const fs = yield* FileSystem.FileSystem
	const metadata = yield* fs
		.readFileString(path.join(artifact.directory, "package.json"))
		.pipe(
			Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Package))),
			Effect.catchCause((cause) => ModuleInvalid.make({ specifier, cause })),
		)
	const externalDependencies = yield* externalInventory(
		metadata,
		owner.directory,
	)
	const suffix = url.search + url.hash
	const exported = yield* inspectModule(
		kernel,
		artifact,
		suffix,
		options,
		kind,
	).pipe(
		Effect.catchTag("ControlError", (error) =>
			ModuleInvalid.make({
				specifier,
				cause: error.cause ?? Cause.fail(error),
				...(error.reason === "PluginExportMissing"
					? { reason: "PluginExportMissing" }
					: {}),
				...(error.preparation === undefined
					? {}
					: { preparation: error.preparation }),
			}),
		),
	)
	return Descriptor.make({
		kind,
		artifact,
		location:
			pathToFileURL(path.join(artifact.directory, artifact.identity.entry))
				.href + suffix,
		base,
		export: exported,
		suffix,
		externalDependencyCoverage: "Declared",
		externalDependencies,
		provenance: {
			specifier,
			source,
			...(metadata.name === undefined ? {} : { package: metadata.name }),
			...(metadata.version === undefined ? {} : { version: metadata.version }),
		},
	})
})

const resolveCustom = Effect.fnUntraced(function* (
	kernel: Control.Client,
	name: string,
	base: string,
	kind: "Plugin" | "Environment",
	resolver: ResolverModule,
	options: Options,
) {
	const target = Units.target({
		artifact: resolver.artifact,
		placement: options.placement ?? "Worker",
		input: { name, base, options: resolver.options },
		inspection: "Module",
		moduleKind: "Resolver",
	})
	const prepared = yield* kernel
		.inspect({
			instance: `resolver:${resolver.artifact.identity.digest}`,
			target,
			...(options.budget === undefined ? {} : { budget: options.budget }),
		})
		.pipe(
			Effect.catchTag("ControlError", (error) =>
				ModuleInvalid.make({
					specifier: name,
					cause: error.cause,
					...(error.preparation === undefined
						? {}
						: { preparation: error.preparation }),
				}),
			),
		)
	if (
		Option.isNone(prepared.result) ||
		prepared.result.value._tag !== "Described" ||
		prepared.result.value.description.inspectionData === undefined
	)
		return yield* ModuleInvalid.make({
			specifier: name,
			cause: prepared.cause,
			preparation: prepared.id,
		})
	const descriptor = yield* Schema.decodeUnknownEffect(Descriptor)(
		prepared.result.value.description.inspectionData,
	).pipe(
		Effect.catchCause((cause) =>
			ModuleInvalid.make({ specifier: name, cause, preparation: prepared.id }),
		),
	)
	const path = yield* Path.Path
	const location =
		pathToFileURL(
			path.join(
				descriptor.artifact.directory,
				descriptor.artifact.identity.entry,
			),
		).href + descriptor.suffix
	if (descriptor.kind !== kind || descriptor.location !== location)
		return yield* ModuleInvalid.make({
			specifier: name,
			cause:
				"Custom resolution must identify captured bytes with the requested export role",
			preparation: prepared.id,
		})
	const exported = yield* inspectModule(
		kernel,
		descriptor.artifact,
		descriptor.suffix,
		options,
		kind,
	).pipe(
		Effect.catchCause((cause) =>
			ModuleInvalid.make({ specifier: name, cause }),
		),
	)
	if (exported !== descriptor.export)
		return yield* ModuleInvalid.make({
			specifier: name,
			cause: "The custom descriptor differs from its inspected export",
		})
	return descriptor
})

export const make = Effect.fnUntraced(function* (options: Options) {
	const kernel = yield* Control.connect(options.control)
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const context = Context.make(FileSystem.FileSystem, fs).pipe(
		Context.add(Path.Path, path),
	)
	const attempt = Effect.fnUntraced(function* (
		specifier: string,
		base: string,
		kind: "Plugin" | "Environment",
	) {
		const located = yield* locate(specifier, base)
		if (Option.isSome(located) && String.startsWith("file:")(located.value)) {
			const file = yield* Effect.try({
				try: () => fileURLToPath(located.value),
				catch: (cause) => ModuleInvalid.make({ specifier, cause }),
			})
			const fs = yield* FileSystem.FileSystem
			const exists = yield* fs
				.exists(file)
				.pipe(
					Effect.mapError((cause) => ModuleInvalid.make({ specifier, cause })),
				)
			if (!exists) return Option.none<Descriptor>()
		}
		return yield* Option.match(located, {
			onNone: () => Effect.succeedNone,
			onSome: (source) =>
				capture(kernel, source, specifier, base, options, kind).pipe(
					Effect.asSome,
				),
		})
	})
	return ModuleResolver.of({
		resolve: Effect.fnUntraced(function* (
			name: string,
			resolveOptions?: ResolveOptions,
		) {
			const kind = resolveOptions?.kind ?? "Plugin"
			const directory = yield* ConfigDirectory
			const base = Option.getOrElse(directory, () => options.base)
			if (options.resolver !== undefined)
				return yield* resolveCustom(
					kernel,
					name,
					base,
					kind,
					options.resolver,
					options,
				)
			const tried = candidates(name)
			const [written, ...conventions] = tried
			const exact =
				written === undefined
					? Result.succeed(Option.none<Descriptor>())
					: yield* attempt(written, base, kind).pipe(Effect.result)
			if (Result.isSuccess(exact) && Option.isSome(exact.success))
				return exact.success.value
			if (
				Result.isFailure(exact) &&
				(exact.failure.reason !== "PluginExportMissing" ||
					conventions.length === 0)
			)
				return yield* exact.failure
			const inspected = yield* Effect.forEach(conventions, (candidate) =>
				attempt(candidate, base, kind),
			)
			const found = Array.getSomes(inspected)
			const [only, ...rest] = found
			if (rest.length > 0)
				return yield* AmbiguousPluginName.make({
					plugin: name,
					packages: Array.map(
						found,
						(descriptor) => descriptor.provenance.specifier,
					),
				})
			if (only !== undefined) return only
			if (Result.isFailure(exact)) return yield* exact.failure
			return yield* ModuleNotFound.make({ plugin: name, tried })
		}, Effect.provideContext(context)),
	})
})
export const layer = (options: Options) =>
	Layer.effect(ModuleResolver, make(options))

/** Files belonging to one entry, retained independently of its activation and retries. */
export interface Observation {
	readonly scope: Scope.Scope
	/** Files registered by one activation accumulate; the next activation's files replace them. */
	readonly watch: (
		files: ReadonlyArray<string>,
		activation: Scope.Scope,
	) => Effect.Effect<void, ModuleInvalid>
	readonly changes: Stream.Stream<void>
}

/** A development host supplies entry-owned source collections. */
export const Watch = Context.Reference(
	"@graftland/loader/ModuleResolver/Watch",
	{
		defaultValue: (): Option.Option<
			Effect.Effect<Observation, never, Scope.Scope>
		> => Option.none(),
	},
)

/** Adds files to the current activation's explicit sources without importing them. */
export const observe = (files: ReadonlyArray<string>) =>
	Effect.flatMap(
		CurrentObservation,
		Option.match({
			onNone: () => Effect.void,
			onSome: ({ observation, activation }) =>
				observation.watch(files, activation),
		}),
	)
