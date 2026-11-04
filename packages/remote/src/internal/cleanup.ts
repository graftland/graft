import { Fork } from "@graftland/graft"
import { Array, Cause, Effect, Schema, Scope } from "effect"

/** Finalizers have no typed failure channel. Keep reasons and their annotations flat. */
export const cleanupCause = (cause: Cause.Cause<unknown>): Cause.Cause<never> =>
	Cause.fromReasons(
		Array.flatMap(cause.reasons, (reason) => {
			const error =
				reason._tag === "Fail"
					? reason.error
					: reason._tag === "Die"
						? reason.defect
						: undefined
			if (Schema.is(Fork.CleanupError)(error))
				return Array.map(cleanupCause(error.cause).reasons, (inner) =>
					inner.annotate(Cause.reasonAnnotations(reason)),
				)
			return [
				reason._tag === "Fail"
					? Cause.makeDieReason(reason.error).annotate(
							Cause.reasonAnnotations(reason),
						)
					: reason,
			]
		}),
	)

/** Assembly children close before the entry reports their cleanup as its own result. */
export const children = Effect.acquireRelease(Scope.make(), (scope, exit) =>
	Scope.close(scope, exit).pipe(
		Effect.catchCause((cause) => Effect.failCause(cleanupCause(cause))),
	),
)
