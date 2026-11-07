/** Composes the editor schema of a project's config file from its installed plugins. */
import {
	Array,
	Effect,
	FileSystem,
	Option,
	Path,
	Predicate,
	Record,
	Schema,
	type PlatformError,
} from "effect"

import { make } from "./configSchema"
import * as Importer from "./importer"

/** A dependency's `./schema` export could not be read. */
export class SchemaRegistrationError extends Schema.TaggedError<
	SchemaRegistrationError,
	{ readonly brand: unique symbol }
>()("SchemaRegistrationError", {
	packageName: Schema.String,
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Unknown),
}) {
	override get message() {
		return `${this.packageName}/schema: ${this.detail}`
	}
}

const Dependencies = Schema.optionalKey(
	Schema.Record(Schema.String, Schema.String),
)
const ProjectManifest = Schema.fromJsonString(
	Schema.Struct({
		dependencies: Dependencies,
		devDependencies: Dependencies,
		optionalDependencies: Dependencies,
	}),
)
const InstalledManifest = Schema.fromJsonString(
	Schema.Struct({
		exports: Schema.optionalKey(Schema.Unknown),
		dependencies: Dependencies,
		peerDependencies: Dependencies,
	}),
)
const Registrations = Schema.Array(
	Schema.Struct({
		names: Schema.Array(Schema.String),
		schema: Schema.Record(Schema.String, Schema.Unknown),
		required: Schema.optionalKey(Schema.Boolean),
	}),
)

/**
 * The manifest of an installed package, looked up as Node does: in
 * `node_modules` of the directory and then of each parent, so hoisted
 * workspace installs are found.
 */
const installedManifest = (
	directory: string,
	packageName: string,
): Effect.Effect<
	Option.Option<string>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.join(
			directory,
			"node_modules",
			packageName,
			"package.json",
		)
		if (yield* fs.exists(file)) return Option.some(file)
		const parent = path.dirname(directory)
		return parent === directory
			? Option.none()
			: yield* installedManifest(parent, packageName)
	})

/**
 * Whether an installed dependency is a plugin package that exports `./schema`,
 * read without importing it. Other packages, such as `effect`, may export a
 * `./schema` of their own.
 */
const exportsSchema = Effect.fnUntraced(function* (
	directory: string,
	packageName: string,
) {
	const fs = yield* FileSystem.FileSystem
	const file = yield* installedManifest(directory, packageName)
	if (Option.isNone(file)) {
		yield* Effect.logWarning(
			`${packageName} is not installed; its config is left open`,
		)
		return false
	}
	const text = yield* fs.readFileString(file.value)
	const manifest = yield* Schema.decodeEffect(InstalledManifest)(text)
	return (
		Predicate.hasProperty(manifest.exports, "./schema") &&
		(Record.has(manifest.dependencies ?? {}, "@graftland/graft") ||
			Record.has(manifest.peerDependencies ?? {}, "@graftland/graft"))
	)
})

const load = Effect.fnUntraced(function* (
	importer: (specifier: string) => Promise<unknown>,
	packageName: string,
) {
	const failed = (detail: string) => (cause: unknown) =>
		SchemaRegistrationError.make({ packageName, detail, cause })
	const module = yield* Effect.tryPromise({
		try: () => importer(`${packageName}/schema`),
		catch: failed("cannot be imported"),
	})
	if (
		!Predicate.hasProperty(module, "entries") ||
		!Predicate.isFunction(module.entries)
	)
		return yield* SchemaRegistrationError.make({
			packageName,
			detail: "does not export an entries function",
		})
	const entries = module.entries
	const value = yield* Effect.try({
		try: () => entries(),
		catch: failed("entries() threw"),
	})
	return yield* Schema.decodeUnknownEffect(Registrations)(value).pipe(
		Effect.mapError(failed("entries() returned invalid registrations")),
	)
})

/**
 * The registrations exported as `./schema` by the dependencies in the
 * project's package.json. Only these modules are imported, never the plugins.
 */
export const registrations = Effect.fn("EditorSchema.registrations")(function* (
	directory: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const text = yield* fs.readFileString(path.join(directory, "package.json"))
	const manifest = yield* Schema.decodeEffect(ProjectManifest)(text)
	const names = Array.dedupe(
		Array.flatMap(
			[
				manifest.dependencies,
				manifest.devDependencies,
				manifest.optionalDependencies,
			],
			(dependencies) => Record.keys(dependencies ?? {}),
		),
	)
	const plugins = yield* Effect.filter(names, (name) =>
		exportsSchema(directory, name),
	)
	const importer = yield* Importer.make(directory)
	const loaded = yield* Effect.forEach(plugins, (name) => load(importer, name))
	return { plugins, entries: Array.flatten(loaded) }
}, Effect.scoped)

const encode = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Unknown, { space: "\t" }),
)

/** Writes the editor schema for the project in a directory. */
export const write = Effect.fn("EditorSchema.write")(function* (
	directory: string,
	output: string,
) {
	const fs = yield* FileSystem.FileSystem
	const { plugins, entries } = yield* registrations(directory)
	const text = yield* encode(make(entries))
	yield* fs.writeFileString(output, text + "\n")
	yield* Effect.logInfo(
		plugins.length === 0
			? `Wrote ${output}; no dependency exports ./schema`
			: `Wrote ${output} with ${Array.join(plugins, ", ")}`,
	)
})
