import { Array, Cause, Schema } from "effect"
import { RemoteError } from "../src/Errors"

/** Assertions inspect the same diagnostics through the public boundary error. */
export const underlying = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
	Cause.fromReasons(
		Array.flatMap(cause.reasons, (reason) =>
			reason._tag === "Fail" && Schema.is(RemoteError)(reason.error)
				? underlying(reason.error.cause).reasons
				: [reason],
		),
	)
