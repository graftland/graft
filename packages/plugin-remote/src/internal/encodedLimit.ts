import { Cause, Effect, Schema } from "effect"

export const maxBytes = 1024 * 1024
export class UnitMessageLimit extends Schema.TaggedError<
	UnitMessageLimit,
	{ readonly brand: unique symbol }
>()("UnitMessageLimit", {
	reason: Schema.Literals(["TooLarge", "Encoding"]),
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
export const check = (value: unknown): Effect.Effect<void, UnitMessageLimit> =>
	encode(value).pipe(
		Effect.mapError((error) =>
			UnitMessageLimit.make({ reason: "Encoding", cause: Cause.fail(error) }),
		),
		Effect.flatMap((encoded) =>
			new TextEncoder().encode(encoded).byteLength > maxBytes
				? UnitMessageLimit.make({
						reason: "TooLarge",
						cause: Cause.fail("The encoded unit message exceeds 1 MiB"),
					})
				: Effect.void,
		),
	)
