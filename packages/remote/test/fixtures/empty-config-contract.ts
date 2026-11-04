import { Schema } from "effect"
import { Contract } from "../../src/index"

export const contract = Contract.make({
	name: "empty-config",
	config: Schema.Struct({}),
	error: Schema.Never,
	module: new URL("./empty-plugin.js", import.meta.url).href,
})
