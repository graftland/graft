import { Schema } from "effect"

export const Bootstrap = Schema.Struct({
	contractModule: Schema.String,
	session: Schema.String,
})
