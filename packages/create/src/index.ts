/**
 * Generates a project from a template. It never asks questions, installs
 * dependencies or runs git; `@graftland/create/Command` does those.
 */
import {
	Array,
	Effect,
	Exit,
	FileSystem,
	Path,
	Predicate,
	Schema,
	String,
	type PlatformError,
} from "effect"

import { PackageName } from "@graftland/package-manager"
import { PackageManagerDeclaration } from "@graftland/package-manager/PackageManagerDeclaration"

import {
	templates,
	type PluginDependency,
	type TemplateName,
} from "./internal/templates"

export { TemplateName } from "./internal/templates"

export class CreateError extends Schema.TaggedError<
	CreateError,
	{ readonly brand: unique symbol }
>()("CreateError", {
	directory: Schema.String,
	message: Schema.String,
}) {}
/** A package name, given, taken from the directory or named by `plugins`, is not a valid npm package name. */
export class InvalidName extends Schema.TaggedError<
	InvalidName,
	{ readonly brand: unique symbol }
>()("InvalidName", {
	packageName: Schema.String,
	message: Schema.String,
}) {}
/** The `packageManager` option is not an exact, supported declaration. */
export class InvalidPackageManager extends Schema.TaggedError<
	InvalidPackageManager,
	{ readonly brand: unique symbol }
>()("InvalidPackageManager", {
	value: Schema.String,
	message: Schema.String,
}) {}
export interface Options {
	readonly directory: string
	/** Defaults to `app`. */
	readonly template?: TemplateName
	/**
	 * Defaults to the target directory's basename, prefixed with
	 * `graft-plugin-` for the `plugin` template.
	 */
	readonly name?: string
	/**
	 * Plugin packages to depend on and load, each `name` or `name@range`. Short
	 * names map as in {@link pluginPackage}.
	 */
	readonly plugins?: ReadonlyArray<string>
	/** Exact SemVer, optionally with a prerelease and a supported Corepack SHA hash. */
	readonly packageManager?: string
	/**
	 * Graft and its CLI default to this package's own version, since every
	 * Graft package is released with the same one. Override these for local
	 * development.
	 */
	readonly versions?: {
		readonly graft?: string
		readonly cli?: string
		readonly effect?: string
	}
}
export interface Project {
	readonly directory: string
	readonly name: string
	readonly template: TemplateName
	/** Paths relative to `directory`, sorted. */
	readonly files: ReadonlyArray<string>
}

/** The checks npm applies to new package names. */
export const Name = Schema.String.check(
	Schema.isPattern(
		/^(?!(?:node_modules|favicon\.ico)$)(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/,
	),
	Schema.isTrimmed(),
	Schema.isMaxLength(214),
)
const decodeName = (requested: string) =>
	Schema.decodeEffect(Name)(requested).pipe(
		Effect.mapError((error) =>
			InvalidName.make({ packageName: requested, message: error.message }),
		),
	)

const encodeJson = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), {
		space: 2,
	}),
)
const Manifest = Schema.fromJsonString(
	Schema.Struct({ version: Schema.String }),
)

/**
 * The version in this package's own manifest, read when a project is created.
 * A missing or invalid manifest means a broken installation, not a caller
 * mistake, so it is a defect.
 */
const ownVersion = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	// A module loaded from disk always has a file URL.
	const file = yield* path
		.fromFileUrl(new URL("../package.json", import.meta.url))
		.pipe(Effect.orDie)
	const text = yield* fs.readFileString(file)
	const manifest = yield* Schema.decodeEffect(Manifest)(text)
	return manifest.version
}).pipe(Effect.orDie)

/**
 * The package a plugin name refers to: `review` is `@graftland/plugin-review`,
 * while scoped and `graft-plugin-*` names stay as they are.
 */
export const pluginPackage = (name: string): string =>
	String.startsWith("@")(name) || String.startsWith("graft-plugin-")(name)
		? name
		: `@graftland/plugin-${name}`

/** Whether Graft can load a package by its short name, as `review` loads `@graftland/plugin-review`. */
export const hasShortName = (name: string): boolean =>
	String.startsWith("graft-plugin-")(name) ||
	String.startsWith("@graftland/plugin-")(name)

/** `name@range`, split at the last `@` so a scope's `@` stays in the name. */
const PluginSpec = Schema.Union([
	Schema.TemplateLiteralParser([
		PackageName,
		"@",
		Schema.String.check(Schema.isMinLength(1)),
	]),
	PackageName,
])
const decodePlugin = (spec: string, version: string) =>
	Schema.decodeEffect(PluginSpec)(spec).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				InvalidName.make({ packageName: spec, message: error.message }),
			onSuccess: (parsed): PluginDependency => {
				const name = pluginPackage(
					Predicate.isString(parsed) ? parsed : parsed[0],
				)
				return {
					name,
					// Graft's own plugins are released with the same version as Graft.
					range: Predicate.isString(parsed)
						? String.startsWith("@graftland/plugin-")(name)
							? version
							: "latest"
						: parsed[2],
				}
			},
		}),
	)

/** Entries that do not keep a directory from counting as empty, such as those of a freshly cloned repository. */
const ignorable: ReadonlyArray<string> = [".git", ".DS_Store"]

/**
 * Fails unless the target does not exist or is a directory that holds nothing
 * but ignorable entries. Succeeds with whether it holds any.
 */
export const checkTarget: (
	directory: string,
) => Effect.Effect<
	boolean,
	CreateError | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = path.resolve(directory)
	if (!(yield* fs.exists(target))) return false
	const stat = yield* fs.stat(target)
	const entries =
		stat.type === "Directory" ? yield* fs.readDirectory(target) : undefined
	if (
		entries === undefined ||
		Array.some(entries, (entry) => !Array.contains(ignorable, entry))
	)
		return yield* CreateError.make({
			directory: target,
			message: "The target must be an empty directory or a new path",
		})
	return entries.length > 0
})

/**
 * Moves each staged entry into a target that keeps its ignorable entries,
 * never replacing one. When a move fails, the entries already moved go back
 * to staging.
 */
const moveEntries = Effect.fnUntraced(function* (
	staging: string,
	directory: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = yield* fs.readDirectory(staging)
	yield* Effect.forEach(
		entries,
		(entry) =>
			Effect.acquireRelease(
				Effect.gen(function* () {
					const target = path.join(directory, entry)
					if (yield* fs.exists(target))
						return yield* CreateError.make({
							directory,
							message: `${entry} appeared in the target while the project was generated`,
						})
					yield* fs.rename(path.join(staging, entry), target)
				}),
				(_, exit) =>
					Exit.isFailure(exit)
						? fs
								.rename(path.join(directory, entry), path.join(staging, entry))
								.pipe(Effect.orDie)
						: Effect.void,
			),
		{ discard: true },
	)
}, Effect.scoped)

/** Copies a template's static files into staging, returning the paths written. */
const copyFiles = Effect.fnUntraced(function* (from: string, to: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const listed = yield* fs.readDirectory(from, { recursive: true })
	const entries = Array.sort(
		Array.filter(
			listed,
			(entry) => !Array.contains(ignorable, path.basename(entry)),
		),
		String.Order,
	)
	const written = yield* Effect.forEach(entries, (entry) =>
		Effect.gen(function* () {
			const source = path.join(from, entry)
			if ((yield* fs.stat(source)).type === "Directory") {
				yield* fs.makeDirectory(path.join(to, entry), { recursive: true })
				return []
			}
			const name =
				path.basename(entry) === "_gitignore"
					? path.join(path.dirname(entry), ".gitignore")
					: entry
			const bytes = yield* fs.readFile(source)
			yield* fs.writeFile(path.join(to, name), bytes)
			return [name]
		}).pipe(
			// Join accepted native writes before cancellation can remove staging.
			Effect.uninterruptible,
		),
	)
	return Array.flatten(written)
})

/**
 * Generates into a directory that does not exist, is empty, or holds only
 * `.git` and `.DS_Store`. Files are staged next to the target and moved into
 * place only after all of them are ready, so a failure leaves the target as it
 * was. Never removes or replaces an existing file. Logs a warning when a
 * `plugin` package is named so that Graft cannot load it by a short name.
 */
export const create: (
	options: Options,
) => Effect.Effect<
	Project,
	| CreateError
	| InvalidName
	| InvalidPackageManager
	| PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> = Effect.fn("Create.create")(function* (options: Options) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const template = templates[options.template ?? "app"]
	const directory = path.resolve(options.directory)
	const name = yield* decodeName(
		options.name ?? template.defaultName(path.basename(directory)),
	)
	const packageManager = options.packageManager
	if (packageManager !== undefined)
		yield* Schema.decodeUnknownEffect(PackageManagerDeclaration)(
			packageManager,
		).pipe(
			Effect.mapError((error) =>
				InvalidPackageManager.make({
					value: packageManager,
					message: error.message,
				}),
			),
		)
	const keep = yield* checkTarget(directory)
	const version = yield* ownVersion
	const plugins = yield* Effect.forEach(options.plugins ?? [], (spec) =>
		decodePlugin(spec, version),
	)
	if (template.name === "plugin" && !hasShortName(name))
		yield* Effect.logWarning(
			`Graft cannot load ${name} by a short name; graft.yml must name it in full. Short names work for graft-plugin-* and @graftland/plugin-* packages.`,
		)
	const context = {
		name,
		packageManager,
		versions: {
			graft: options.versions?.graft ?? version,
			cli: options.versions?.cli ?? version,
			effect: options.versions?.effect ?? "4.1.2",
		},
		plugins,
	}
	// Strings and plain objects always encode.
	const manifest = yield* encodeJson(template.manifest(context)).pipe(
		Effect.orDie,
	)
	yield* fs
		.makeDirectory(path.dirname(directory), { recursive: true })
		.pipe(Effect.uninterruptible)
	const staging = yield* fs.makeTempDirectoryScoped({
		directory: path.dirname(directory),
		prefix: ".graft-create-",
	})
	const generated = [
		["package.json", manifest + "\n"],
		["graft.yml", template.config(context)],
	] as const
	yield* Effect.forEach(
		generated,
		([name, content]) =>
			// Join accepted native writes before cancellation can remove staging.
			fs
				.writeFileString(path.join(staging, name), content)
				.pipe(Effect.uninterruptible),
		{ discard: true },
	)
	const files = yield* template.files
	const copied = yield* copyFiles(files, staging)
	yield* keep
		? moveEntries(staging, directory)
		: fs.rename(staging, directory).pipe(Effect.uninterruptible)
	return {
		directory,
		name,
		template: template.name,
		files: Array.sort(
			[...Array.map(generated, ([name]) => name), ...copied],
			String.Order,
		),
	}
}, Effect.scoped)
