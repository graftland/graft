/** A local, non-interactive template. Installation is a separate package-manager operation. */
import { PackageManagerDeclaration } from "@graftland/package-manager/PackageManagerDeclaration"
import { Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect"

export class CreateError extends Schema.TaggedError<
	CreateError,
	{ readonly brand: unique symbol }
>()("CreateError", {
	directory: Schema.String,
	message: Schema.String,
}) {}
export interface Options {
	readonly directory: string
	/** Defaults to the target directory's basename. */
	readonly name?: string
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
	readonly files: ReadonlyArray<string>
}
const Name = Schema.String.check(
	Schema.isPattern(
		/^(?!(?:node_modules|favicon\.ico)$)(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/,
	),
	Schema.isTrimmed(),
	Schema.isMaxLength(214),
)
const encodeJson = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), {
		space: 2,
	}),
)
const Manifest = Schema.fromJsonString(
	Schema.Struct({ version: Schema.String }),
)

/** The version in this package's own manifest, read when a project is created. */
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
})

const plugin = `import { Plugin } from "@graftland/graft"
import { Effect, Schema } from "effect"

// Module evaluation only defines the plugin; its activation owns all resources.
export default Plugin.make({
  name: "hello",
  config: Schema.Struct({ message: Schema.String }),
  apply: ({ message }) => Effect.acquireRelease(
    Effect.logInfo(message),
    () => Effect.logInfo("Hello plugin stopped"),
  ),
})
`
/**
 * The JSON Schema of graft.yml as released with a version of Graft. Every
 * package shares that version, and npm keeps each release's files unchanged.
 */
export const schemaUrl = (version: string): string =>
	`https://cdn.jsdelivr.net/npm/@graftland/cli@${version}/schema.json`

const config = (
	version: string,
) => `# yaml-language-server: $schema=${schemaUrl(version)}
- id: hello
  name: ./hello.mjs
  config:
    message: Hello from Graft!
`

/**
 * Generates into an absent or empty directory. A staged directory is renamed
 * into place only after all files are ready. Never removes an existing project.
 * After installation, npm start (or graft start) loads the example plugin.
 */
export const create = (
	options: Options,
): Effect.Effect<
	Project,
	CreateError | PlatformError.PlatformError | Schema.SchemaError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const directory = path.resolve(options.directory)
			const name = yield* Schema.decodeEffect(Name)(
				options.name ?? path.basename(directory),
			)
			if (options.packageManager !== undefined)
				yield* Schema.decodeUnknownEffect(PackageManagerDeclaration)(
					options.packageManager,
				)
			if (yield* fs.exists(directory)) {
				const stat = yield* fs.stat(directory)
				if (
					stat.type !== "Directory" ||
					(yield* fs.readDirectory(directory)).length > 0
				)
					return yield* CreateError.make({
						directory,
						message: "The target must be an empty directory or a new path",
					})
			}
			const version = yield* ownVersion
			const manifest = yield* encodeJson({
				name,
				version: "0.0.0",
				private: true,
				type: "module",
				...(options.packageManager === undefined
					? {}
					: { packageManager: options.packageManager }),
				scripts: { start: "graft start" },
				dependencies: {
					"@graftland/graft": options.versions?.graft ?? version,
					"@graftland/cli": options.versions?.cli ?? version,
					effect: options.versions?.effect ?? "4.1.2",
				},
			})
			yield* fs
				.makeDirectory(path.dirname(directory), { recursive: true })
				.pipe(Effect.uninterruptible)
			const staging = yield* fs.makeTempDirectoryScoped({
				directory: path.dirname(directory),
				prefix: ".graft-create-",
			})
			const files = [
				["package.json", manifest + "\n"],
				["graft.yml", config(version)],
				["hello.mjs", plugin],
				[".gitignore", "node_modules/\n.env\n"],
			] as const
			yield* Effect.forEach(
				files,
				([name, content]) =>
					// Join accepted native writes before cancellation can remove staging.
					fs
						.writeFileString(path.join(staging, name), content)
						.pipe(Effect.uninterruptible),
				{ discard: true },
			)
			yield* fs.rename(staging, directory).pipe(Effect.uninterruptible)
			return {
				directory,
				name,
				files: ["package.json", "graft.yml", "hello.mjs", ".gitignore"],
			}
		}),
	)
