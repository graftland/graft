import { Array, Cause, Effect } from "effect"

/** The caller has observed interruption; preserve cancellation and log every additional reason. */
export const cancelled = (cause: Cause.Cause<unknown>) =>
	(Cause.hasInterruptsOnly(cause)
		? Effect.void
		: Effect.logError("Sandbox preparation was interrupted", cause)
	).pipe(
		Effect.andThen(
			Effect.failCause(
				Cause.fromReasons<never>(
					Array.filter(cause.reasons, Cause.isInterruptReason),
				),
			),
		),
	)
