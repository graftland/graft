import { Cause, Effect, Exit, Schema, Scope } from "effect"

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
	Scope.close(scope, exit).pipe(
		Effect.catchCause((cause) =>
			Effect.failCause(
				Cause.hasInterruptsOnly(cause)
					? Cause.die(ReleaseInterrupted.make({ cause }))
					: cause,
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
