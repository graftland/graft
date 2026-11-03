import { Array, Cause } from "effect"

/** Finalizers have no typed failure channel. Keep reasons and their annotations flat. */
export const cleanupCause = (cause: Cause.Cause<unknown>): Cause.Cause<never> =>
	Cause.fromReasons(
		Array.map(cause.reasons, (reason) =>
			reason._tag === "Fail"
				? Cause.makeDieReason(reason.error).annotate(
						Cause.reasonAnnotations(reason),
					)
				: reason,
		),
	)
