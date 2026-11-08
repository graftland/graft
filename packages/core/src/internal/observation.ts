import { Schema } from "effect"

export class UnknownChange extends Schema.TaggedError<
	UnknownChange,
	{ readonly brand: unique symbol }
>()("UnknownChange", { id: Schema.String }) {}
