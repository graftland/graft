import { Schema } from "effect"

export class ConformanceError extends Schema.TaggedError<
	ConformanceError,
	{ readonly brand: unique symbol }
>()("ConformanceError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
