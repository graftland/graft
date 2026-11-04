import { Array, Cause, Effect, Exit, Result, Schema, Scope } from "effect"

/** Resource release was interrupted, rather than successfully cancelled. */
export class ReleaseInterrupted extends Schema.TaggedError<
	ReleaseInterrupted,
	{ readonly brand: unique symbol }
>()("ReleaseInterrupted", {
	cause: Schema.Cause(Schema.Never, Schema.Unknown),
}) {
	override get message() {
		return "Resource release was interrupted"
	}
}

/** Keep a known release failure distinguishable from cancellation through enclosing scopes. */
export const close = (
	scope: Scope.Closeable,
	exit: Exit.Exit<unknown, unknown>,
) =>
	Effect.uninterruptible(
		Scope.close(scope, exit).pipe(
			Effect.catchCauseIf(Cause.hasInterruptsOnly, (cause) =>
				Effect.gen(function* () {
					// Re-entering interruptibility observes pending external cancellation without producing a self-interrupt.
					// Read it after release so cancellation arriving during a finalizer is included too.
					const pending = yield* Effect.exit(Effect.interruptible(Effect.void))
					const [cancelled, interrupted] = Array.partition(
						cause.reasons,
						(reason) =>
							Exit.isFailure(pending) &&
							Array.some(
								pending.cause.reasons,
								(external) =>
									reason._tag === "Interrupt" &&
									external._tag === "Interrupt" &&
									reason.fiberId === external.fiberId,
							)
								? Result.succeed(reason)
								: Result.fail(reason),
					)
					if (interrupted.length === 0) return yield* Effect.failCause(cause)
					return yield* Effect.failCause(
						Cause.combine(
							Cause.fromReasons(cancelled),
							Cause.die(
								ReleaseInterrupted.make({
									cause: Cause.fromReasons(interrupted),
								}),
							),
						),
					)
				}),
			),
		),
	)

export const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			const body = yield* Effect.exit(restore(Scope.provide(scope)(effect)))
			const closed = yield* Effect.exit(close(scope, body))
			if (Exit.isFailure(closed))
				return yield* Effect.failCause(
					Exit.isFailure(body)
						? Cause.combine(body.cause, closed.cause)
						: closed.cause,
				)
			return yield* body
		}),
	)
