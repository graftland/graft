import { Array, Cause } from "effect"

/** Recovery is safe only when no companion failure, defect or interruption would be discarded. */
export const isOnlyFailure = <E>(
	cause: Cause.Cause<E>,
	matches: (error: E) => boolean,
): boolean =>
	cause.reasons.length === 1 &&
	Array.some(
		cause.reasons,
		(reason) => Cause.isFailReason(reason) && matches(reason.error),
	)
