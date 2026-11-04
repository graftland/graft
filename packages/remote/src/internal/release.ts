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
