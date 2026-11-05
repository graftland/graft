import { Cause, Deferred, Effect, Exit, Ref, Scope } from "effect"

import * as Release from "../Release"

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
	// Tracks whether the explicit close caller that owns the result is still waiting for it.
	// Whoever sees the other side finish last reports a failure nobody observed.
	const observer = yield* Ref.make<"waiting" | "abandoned" | "settled">(
		"waiting",
	)
	const reportUnobserved = (result: Exit.Exit<void, E>) =>
		Exit.isFailure(result)
			? Effect.logError(
					"Fork cleanup failed after its dispose caller was interrupted",
					result.cause,
				)
			: Effect.void
	// Resolves to true only for the caller that started cleanup; that caller owns its result.
	const start = Effect.fnUntraced(function* (
		exit: Exit.Exit<unknown, unknown>,
	) {
		if (!(yield* Deferred.succeed(started, undefined))) return false
		yield* Effect.gen(function* () {
			const result = yield* Effect.exit(
				Effect.gen(function* () {
					const closed = yield* Effect.exit(Release.close(scope, exit))
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
			yield* Release.close(link, exit).pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Closing fork ownership failed", cause),
				),
			)
			yield* Deferred.done(completed, result)
			const abandoned = yield* Ref.modify(
				observer,
				(state): [boolean, "settled"] => [state === "abandoned", "settled"],
			)
			if (abandoned) yield* reportUnobserved(result)
		}).pipe(
			Effect.forkIn(workers, {
				uninterruptible: true,
				startImmediately: false,
			}),
		)
		return true
	})
	const close = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void, E> =>
		Effect.uninterruptibleMask((restore) =>
			start(exit).pipe(
				Effect.flatMap((owner) =>
					owner
						? restore(Deferred.await(completed)).pipe(
								Effect.onInterrupt(() =>
									Ref.modify(observer, (state) =>
										state === "waiting"
											? [false, "abandoned" as const]
											: [true, state],
									).pipe(
										Effect.flatMap((settled) =>
											// The worker already finished, so this await returns at once.
											settled
												? Effect.flatMap(
														Effect.exit(Deferred.await(completed)),
														reportUnobserved,
													)
												: Effect.void,
										),
									),
								),
							)
						: restore(Deferred.await(completed)),
				),
			),
		)
	yield* Scope.addFinalizerExit(link, (exit) =>
		start(exit).pipe(
			Effect.flatMap((owner) =>
				owner
					? // Scope finalizers cannot have typed errors; the parent receives the failure as a defect.
						Effect.orDie(Deferred.await(ready))
					: // The explicit close caller owns the result: it receives it, or the worker logs it if that caller was interrupted.
						Effect.asVoid(Effect.exit(Deferred.await(ready))),
			),
			Effect.ensuring(Release.close(workers, exit)),
		),
	)
	return { scope, close }
})
