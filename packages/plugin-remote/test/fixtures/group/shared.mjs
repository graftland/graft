import { Context, Schema } from "effect"

export class Value extends Context.Service()("fixture/group/value") {}
export const configuration = Schema.Struct({
	directory: Schema.String,
	fault: Schema.Literals(["none", "ordinary", "blocked"]),
})
