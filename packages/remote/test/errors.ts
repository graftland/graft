import { Array, Cause, Option, Predicate, Schema } from "effect"
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

/**
 * Finds the first typed failure matching `schema`, looking through errors and
 * defects that carry a nested cause. Unlike matching `Cause.pretty` text, this
 * does not accept the same error as a defect.
 */
export const findFailure =
	<S extends Schema.Constraint>(schema: S) =>
	(cause: Cause.Cause<unknown>): Option.Option<S["Type"]> =>
		Array.findFirst(cause.reasons, (reason) => {
			if (reason._tag === "Fail") {
				const error: unknown = reason.error
				if (Schema.is(schema)(error)) return Option.some<S["Type"]>(error)
				const nested: unknown = error
				if (
					Predicate.hasProperty(nested, "cause") &&
					Cause.isCause(nested.cause)
				)
					return findFailure(schema)(nested.cause)
			}
			if (reason._tag === "Die" && Cause.isCause(reason.defect))
				return findFailure(schema)(reason.defect)
			return Option.none()
		})

/** Asserts that `cause` carries a typed failure matching `schema` and returns it. */
export const expectFailure = <S extends Schema.Constraint>(
	cause: Cause.Cause<unknown>,
	schema: S,
): S["Type"] =>
	Option.getOrElse(findFailure(schema)(cause), () => {
		throw new Error(`Expected a typed failure in:\n${Cause.pretty(cause)}`)
	})
