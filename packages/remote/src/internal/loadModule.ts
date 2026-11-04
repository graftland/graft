import { Cause, Effect } from "effect"
import { ModuleImportFailed } from "./childErrors"

/** Native imports cannot be cancelled; late rejection still belongs to the importing context. */
export const loadModule = Effect.fn("Remote.loadModule")(function* (
	module: string,
) {
	const context = yield* Effect.context<never>()
	return yield* Effect.tryPromise({
		try: (signal) =>
			import(module).catch((cause) => {
				if (signal.aborted)
					Effect.runSyncWith(context)(
						Effect.logError(
							"Module import failed after cancellation",
							Cause.die(cause),
						).pipe(Effect.annotateLogs({ module })),
					)
				throw cause
			}),
		catch: (cause) => ModuleImportFailed.make({ module, cause }),
	})
})
