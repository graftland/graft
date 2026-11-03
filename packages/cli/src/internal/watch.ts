import type * as Hmr from "@graftland/hmr"
import { Array, Cause, Effect, Exit, Stream, String } from "effect"

const moduleExtensions = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]

/** Whether a change to this file should reload plugin modules. */
export const isModule = (path: string) =>
	!Array.contains(String.split(/[/\\]/)(path), "node_modules") &&
	Array.some(moduleExtensions, (extension) => String.endsWith(extension)(path))

const describe = (result: Hmr.ReloadResult) =>
	result._tag === "Reloaded"
		? Effect.logInfo(`Reloaded ${result.entries.length} plugin module(s)`)
		: Effect.logWarning(
				result.reason === "ambiguous-exports"
					? `Restart required: shared plugin exports diverged in ${Array.join(result.modules, ", ")}`
					: result.reason === "identity-conflict"
						? `Restart required: plugin replacement identities conflict in ${Array.join(result.modules, ", ")}`
						: `Restart required to pick up ${Array.join(result.modules, ", ")}`,
			)

/** Owns the HMR stream and retries failed loader entries after each reload. */
export const watchModules = <E, R>(
	hmr: Pick<Hmr.Hmr, "watch">,
	directory: string,
	retry: Effect.Effect<void, E, R>,
) =>
	hmr.watch([directory], { recursive: true, filter: isModule }).pipe(
		Stream.runForEach((result) =>
			Effect.gen(function* () {
				if (result._tag === "Failed")
					return yield* Effect.failCause(result.cause)
				yield* describe(result)
				yield* retry
			}).pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterrupts(cause),
					(cause) => Effect.logError("Reloading plugin modules failed", cause),
				),
			),
		),
		Effect.catchCauseIf(
			(cause) => !Cause.hasInterrupts(cause),
			(cause) => Effect.logError("Watching plugin modules failed", cause),
		),
		// A backend failure ends the stream. Reinstall it after a delay rather than
		// leaving the application running without a watcher.
		Effect.andThen(Effect.sleep("1 second")),
		Effect.forever,
		// onExit runs uninterruptibly, after stream cleanup. Observe the entire
		// worker before forkScoped owns it, including mixed interruption causes.
		Effect.onExit((exit) =>
			Exit.isFailure(exit) &&
			(Cause.hasFails(exit.cause) || Cause.hasDies(exit.cause))
				? Effect.logError("Module watcher exited with a failure", exit.cause)
				: Effect.void,
		),
	)
