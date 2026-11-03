/** A local, non-interactive template. Installation is a separate package-manager operation. */
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
	/** An exact packageManager declaration, such as pnpm@9.15.9. */
	readonly packageManager?: string
	/** Override these for unpublished releases or local development. */
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
	Schema.isPattern(/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/),
	Schema.isMaxLength(214),
)
const PackageManager = Schema.String.check(
	Schema.isPattern(/^(npm|pnpm|yarn)@\d+\.\d+\.\d+(?:[-+].*)?$/),
)
const encodeJson = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), {
		space: 2,
	}),
)
const plugin = `import { Plugin } from "@nmnmcc/graft"
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
const config = `- id: hello
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
				yield* Schema.decodeEffect(PackageManager)(options.packageManager)
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
					"@nmnmcc/graft": options.versions?.graft ?? "0.0.0",
					"@nmnmcc/graft-cli": options.versions?.cli ?? "0.0.0",
					effect: options.versions?.effect ?? "4.1.2",
				},
			})
			yield* fs.makeDirectory(path.dirname(directory), { recursive: true })
			const staging = yield* fs.makeTempDirectoryScoped({
				directory: path.dirname(directory),
				prefix: ".graft-create-",
			})
			const files = [
				["package.json", manifest + "\n"],
				["graft.yml", config],
				["hello.mjs", plugin],
				[".gitignore", "node_modules/\n.env\n"],
			] as const
			yield* Effect.forEach(
				files,
				([name, content]) =>
					fs.writeFileString(path.join(staging, name), content),
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
