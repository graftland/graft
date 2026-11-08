/**
 * Where `!env` values come from: the process environment, then an optional
 * `.env` file, then an optional directory of secret files.
 */
import {
	Array,
	ConfigProvider,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Record,
	Ref,
	String,
	type PlatformError,
} from "effect"

// An empty variable is still set: it overrides the file, and the plugin's
// schema decides whether it is valid.
const options = { preserveEmptyStrings: true } as const

export type Reload = Effect.Effect<boolean, PlatformError.PlatformError>

export class EnvFile extends Context.Service<
	EnvFile,
	{
		/** Reads the file again; reports whether its contents changed. */
		readonly reload: Reload
	}
>()("@graftland/cli/internal/env/EnvFile") {}

export class EnvDir extends Context.Service<
	EnvDir,
	{
		/** Reads the directory again; reports whether any value changed. */
		readonly reload: Reload
	}
>()("@graftland/cli/internal/env/EnvDir") {}

const unchanged = { reload: Effect.succeed(false) }

/**
 * A source that keeps the provider read from its latest snapshot. A failed
 * read keeps the previous snapshot.
 */
const source = Effect.fnUntraced(function* <A>(
	read: Effect.Effect<A, PlatformError.PlatformError>,
	provider: (snapshot: A) => ConfigProvider.ConfigProvider,
	same: (a: A, b: A) => boolean,
) {
	const initial = yield* read
	const loaded = yield* Ref.make({
		snapshot: initial,
		provider: provider(initial),
	})
	return {
		provider: ConfigProvider.make((path) =>
			Effect.flatMap(Ref.get(loaded), ({ provider }) => provider.load(path)),
		),
		reload: Effect.gen(function* () {
			const snapshot = yield* read
			const previous = yield* Ref.getAndSet(loaded, {
				snapshot,
				provider: provider(snapshot),
			})
			return !same(snapshot, previous.snapshot)
		}),
	}
})

const readFile = Effect.fnUntraced(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	// Resolve the request on every read, including polling. Never pin a
	// symlink to its initial target.
	const target = yield* fs.realPath(file)
	return yield* fs.readFileString(target)
})

const isNotFound = (error: PlatformError.PlatformError) =>
	error.reason._tag === "NotFound"

/**
 * One variable per regular file, named after the file. Hidden entries are
 * skipped, which also skips the bookkeeping links of Kubernetes volumes.
 * Trailing line breaks are not part of the value.
 */
const readDir = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const names = yield* fs.readDirectory(directory)
	const values = yield* Effect.forEach(
		Array.filter(names, (name) => !String.startsWith(".")(name)),
		(name) => {
			const file = path.join(directory, name)
			return fs.stat(file).pipe(
				Effect.flatMap((info) =>
					info.type === "File"
						? fs
								.readFileString(file)
								.pipe(
									Effect.map((text) =>
										Option.some([
											name,
											String.replace(/[\r\n]+$/, "")(text),
										] as const),
									),
								)
						: Effect.succeedNone,
				),
				// A file removed since the listing is no longer a variable.
				Effect.catchIf(isNotFound, () => Effect.succeedNone),
			)
		},
		{ concurrency: 16 },
	)
	return Record.fromEntries(Array.getSomes(values))
})

const sameValues = Record.makeEquivalence(String.Equivalence)

/**
 * Provides `ConfigProvider`, `EnvFile` and `EnvDir`. A missing file or
 * directory fails the layer.
 */
export const layer = (sources: {
	readonly file?: string | undefined
	readonly dir?: string | undefined
}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const provide = <A>(
				read: Effect.Effect<
					A,
					PlatformError.PlatformError,
					FileSystem.FileSystem | Path.Path
				>,
			) =>
				read.pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
				)
			const file =
				sources.file === undefined
					? undefined
					: yield* source(
							provide(readFile(sources.file)),
							(text) => ConfigProvider.fromDotEnvContents(text, options),
							(a, b) => a === b,
						)
			const dir =
				sources.dir === undefined
					? undefined
					: yield* source(
							provide(readDir(sources.dir)),
							(values) => ConfigProvider.fromEnvRecord(values, options),
							sameValues,
						)
			const provider = Array.reduce(
				[file, dir],
				ConfigProvider.fromEnv(options),
				(first, next) =>
					next === undefined
						? first
						: ConfigProvider.orElse(first, next.provider),
			)
			return Layer.mergeAll(
				ConfigProvider.layer(provider),
				Layer.succeed(EnvFile, file ?? unchanged),
				Layer.succeed(EnvDir, dir ?? unchanged),
			)
		}),
	)
