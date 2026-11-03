import { Cause, Deferred, Effect, Exit, Scope } from "effect"

/** Keep ownership until cleanup finishes, even if a dispose caller is cancelled. */
export const ownedScope = Effect.fnUntraced(function* <E = never>(
	parent: Scope.Scope,
	afterClose: Effect.Effect<void, E> = Effect.void,
) {
	const link = yield* Scope.fork(parent)
	const scope = yield* Scope.make()
	const workers = yield* Scope.make()
	const started = yield* Deferred.make<void>()
	// The parent can observe cleanup before the worker detaches its link. Public callers wait for detachment too.
	const ready = yield* Deferred.make<void, E>()
	const completed = yield* Deferred.make<void, E>()
	const start = (exit: Exit.Exit<unknown, unknown>) =>
		Effect.gen(function* () {
			if (!(yield* Deferred.succeed(started, undefined))) return
			yield* Effect.gen(function* () {
				const result = yield* Effect.exit(
					Effect.gen(function* () {
						const closed = yield* Effect.exit(Scope.close(scope, exit))
						const observed = yield* Effect.exit(afterClose)
						if (Exit.isFailure(closed))
							return yield* Effect.failCause(
								Exit.isFailure(observed)
									? Cause.combine(closed.cause, observed.cause)
									: closed.cause,
							)
						if (Exit.isFailure(observed))
							return yield* Effect.failCause(observed.cause)
					}),
				)
				yield* Deferred.done(ready, result)
				yield* Scope.close(link, exit).pipe(
					Effect.catchCause((cause) =>
						Effect.logError("Closing fork ownership failed", cause),
					),
				)
				yield* Deferred.done(completed, result)
			}).pipe(
				Effect.forkIn(workers, {
					uninterruptible: true,
					startImmediately: false,
				}),
			)
		})
	const close = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void, E> =>
		Effect.uninterruptibleMask((restore) =>
			start(exit).pipe(Effect.andThen(restore(Deferred.await(completed)))),
		)
	yield* Scope.addFinalizerExit(link, (exit) =>
		start(exit).pipe(
			Effect.andThen(Deferred.await(ready)),
			// Scope finalizers cannot have typed errors; explicit close callers retain the original Exit.
			Effect.orDie,
			Effect.ensuring(Scope.close(workers, exit)),
		),
	)
	return { scope, close }
})
