import { Schema } from "effect"

export const Bootstrap = Schema.Struct({
	contractModule: Schema.String,
	implementation: Schema.String,
	session: Schema.String,
})
