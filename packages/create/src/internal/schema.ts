/**
 * Writes a new project's editor schema with the project's own CLI, which knows
 * the version of Graft the project uses and the plugins it just installed.
 */
import {
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
	String,
	type PlatformError,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class GraftSchemaError extends Schema.TaggedError<
	GraftSchemaError,
	{ readonly brand: unique symbol }
>()("GraftSchemaError", {
	message: Schema.String,
}) {}

const CliManifest = Schema.fromJsonString(
	Schema.Struct({ bin: Schema.Struct({ graft: Schema.String }) }),
)

/** The installed CLI's manifest, looked up as Node does, in this and each parent `node_modules`. */
const cliManifest = (
	directory: string,
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
			"@graftland",
			"cli",
			"package.json",
		)
		if (yield* fs.exists(file)) return Option.some(file)
		const parent = path.dirname(directory)
		return parent === directory ? Option.none() : yield* cliManifest(parent)
	})

/** Runs `graft schema` with the `@graftland/cli` installed for the project. */
export const write = Effect.fn("Create.writeSchema")(function* (
	directory: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const found = yield* cliManifest(directory)
	if (Option.isNone(found))
		return yield* GraftSchemaError.make({
			message: "@graftland/cli is not installed",
		})
	const manifestFile = found.value
	const text = yield* fs.readFileString(manifestFile)
	const manifest = yield* Schema.decodeEffect(CliManifest)(text)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(
		ChildProcess.make(
			process.execPath,
			[path.join(path.dirname(manifestFile), manifest.bin.graft), "schema"],
			{ cwd: directory, stdin: "ignore", stdout: "ignore" },
		),
	)
	const [stderr, exitCode] = yield* Effect.all(
		[Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
		{ concurrency: 2 },
	)
	if (exitCode !== 0)
		return yield* GraftSchemaError.make({
			message:
				String.trim(stderr) || `graft schema exited with code ${exitCode}`,
		})
}, Effect.scoped)
