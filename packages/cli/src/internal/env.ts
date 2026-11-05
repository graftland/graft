/**
 * Where `!env` values come from: the process environment, then an optional
 * `.env` file that watch mode reads again when it changes.
 */
import { observeShutdown } from "./observeShutdown"
import type { PlatformError } from "effect"
import {
	Cause,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Path,
	Queue,
	Ref,
	Stream,
} from "effect"

// An empty variable is still set: it overrides the file, and the plugin's
// schema decides whether it is valid.
const options = { preserveEmptyStrings: true } as const

interface Loaded {
	readonly target: string
	readonly text: string
	readonly provider: ConfigProvider.ConfigProvider
}

export class EnvFile extends Context.Service<
	EnvFile,
	{
		/** Reads the file again; reports whether its contents changed. */
		readonly reload: Effect.Effect<boolean, PlatformError.PlatformError>
	}
>()("@graftland/cli/internal/env/EnvFile") {}

/** Provides `ConfigProvider` and `EnvFile`; a missing file fails the layer. */
export const layer = (file: string | undefined) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const environment = ConfigProvider.fromEnv(options)
			if (file === undefined)
				return Layer.merge(
					ConfigProvider.layer(environment),
					Layer.succeed(EnvFile, { reload: Effect.succeed(false) }),
				)
			const fs = yield* FileSystem.FileSystem
			// Resolve the request on every read, including polling. Never pin a
			// symlink to its initial target. The provider and its baseline are
			// committed together from the bytes actually read.
			const read = Effect.gen(function* () {
				const target = yield* fs.realPath(file)
				const text = yield* fs.readFileString(target)
				return {
					target,
					text,
					provider: ConfigProvider.fromDotEnvContents(text, options),
				}
			})
			const initial: Loaded = yield* read
			const loaded = yield* Ref.make(initial)
			const fromFile = ConfigProvider.make((path) =>
				Effect.flatMap(Ref.get(loaded), ({ provider }) => provider.load(path)),
			)
			return Layer.merge(
				ConfigProvider.layer(ConfigProvider.orElse(environment, fromFile)),
				Layer.succeed(EnvFile, {
					reload: Effect.gen(function* () {
						const next = yield* read
						const previous = yield* Ref.getAndSet(loaded, next)
						return next.text !== previous.text
					}),
				}),
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
	reload: Effect.Effect<boolean, PlatformError.PlatformError>,
	retry: Effect.Effect<void, E, R>,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const ready = yield* Deferred.make<void>()
	// As in HMR, own the source scope inside the producer. Observe its
	// complete Exit after cleanup, before merge can discard it.
	const events = Stream.callback<
		FileSystem.WatchEvent,
		PlatformError.PlatformError
	>(
		(queue) =>
			fs
				.watch(path.dirname(file), {
					onReady: () => Deferred.doneUnsafe(ready, Effect.void),
				})
				.pipe(
					Stream.filter(
						(event) => path.basename(event.path) === path.basename(file),
					),
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
