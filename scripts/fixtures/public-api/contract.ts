import { Contract } from "@graftland/plugin-remote"
import { Schema } from "effect"
export const contract = Contract.make({
	name: "greeter",
	config: Schema.Struct({}),
	module: "./greeter.js",
})
