import { Schema } from "effect"

export class TransportError extends Schema.TaggedError<
	TransportError,
	{ readonly brand: unique symbol }
>()("TransportError", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}
