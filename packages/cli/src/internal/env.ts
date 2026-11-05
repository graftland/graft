/**
 * Where `!env` values come from: the process environment, then an optional
 * `.env` file, then an optional directory of secret files. Watch mode reads
 * the file and the directory again when they change.
 */
import {
	Array,
	Cause,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	Queue,
	Record,
	Ref,
	Stream,
	String,
	type PlatformError,
} from "effect"

import { observeShutdown } from "./observeShutdown"

// An empty variable is still set: it overrides the file, and the plugin's
// schema decides whether it is valid.
const options = { preserveEmptyStrings: true } as const

type Reload = Effect.Effect<boolean, PlatformError.PlatformError>

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

/**
 * The handlers below let interruption through, and with it any failure raised
 * while stopping. Log those; failures without interruption are handled there.
 */
const logStopped =
	(file: string) =>
	<A, E>(exit: Exit.Exit<A, E>) =>
		Exit.isFailure(exit) &&
		Cause.hasInterrupts(exit.cause) &&
		(Cause.hasFails(exit.cause) || Cause.hasDies(exit.cause))
			? Effect.logError(`Watching ${file} stopped with a failure`, exit.cause)
			: Effect.void

/**
 * Reloads the file when it changes and retries the loader's entries, which
 * reads `!env` again. A file that cannot be read keeps its previous values.
 */
export const watchEnvFile = Effect.fnUntraced(function* <E, R>(
	file: string,
	reload: Reload,
	retry: Effect.Effect<void, E, R>,
) {
	const path = yield* Path.Path
	const name = path.basename(file)
	return yield* watchSource(
		file,
		path.dirname(file),
		(changed) => path.basename(changed) === name,
		reload,
		retry,
	)
})

/**
 * Reloads the directory when anything in it changes and retries the loader's
 * entries. A directory that cannot be read keeps its previous values.
 */
export const watchEnvDir = <E, R>(
	directory: string,
	reload: Reload,
	retry: Effect.Effect<void, E, R>,
) => watchSource(directory, directory, () => true, reload, retry)

const watchSource = Effect.fnUntraced(function* <E, R>(
	file: string,
	directory: string,
	matches: (path: string) => boolean,
	reload: Reload,
	retry: Effect.Effect<void, E, R>,
) {
	const fs = yield* FileSystem.FileSystem
	const ready = yield* Deferred.make<void>()
	// As in HMR, own the source scope inside the producer. Observe its
	// complete Exit after cleanup, before merge can discard it.
	const events = Stream.callback<
		FileSystem.WatchEvent,
		PlatformError.PlatformError
	>(
		(queue) =>
			fs
				.watch(directory, {
					onReady: () => Deferred.doneUnsafe(ready, Effect.void),
				})
				.pipe(
					Stream.filter((event) => matches(event.path)),
					Stream.runForEachArray((events) => Queue.offerAll(queue, events)),
					Effect.scoped,
					(effect) =>
						observeShutdown(
							effect,
							`Watching ${file} stopped with interrupted cleanup`,
						),
					Effect.onExit(logStopped(file)),
					Effect.catchCauseIf(
						(cause) => !Cause.hasInterrupts(cause),
						(cause) => Effect.logError(`Watching ${file} failed`, cause),
					),
					// A failed native backend must not stop content reconciliation.
					Effect.andThen(Effect.sleep("1 second")),
					Effect.forever,
				),
		{ bufferSize: 16 },
	)
	// Native events accelerate updates. Poll the request too: its target
	// may live outside this directory, change, or lose a notification.
	yield* Stream.mergeAll(
		[
			Stream.as(events, undefined),
			Stream.fromEffect(Deferred.await(ready)),
			Stream.tick("1 second").pipe(Stream.drop(1)),
		],
		{ concurrency: "unbounded" },
	).pipe(
		Stream.runForEach(() =>
			// Delay to let writes settle.
			Effect.sleep("100 millis").pipe(
				Effect.andThen(reload),
				Effect.flatMap((changed) => (changed ? retry : Effect.void)),
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterrupts(cause),
					(cause) => Effect.logError(`Reloading ${file} failed`, cause),
				),
			),
		),
		Effect.catchCauseIf(
			(cause) => !Cause.hasInterrupts(cause),
			(cause) => Effect.logError(`Stopped watching ${file}`, cause),
		),
		// Observe the whole watcher before forkScoped owns it. The steps
		// before the stream cannot fail, so this covers every failure.
		Effect.onExit(logStopped(file)),
	)
})
