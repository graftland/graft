import { Schema } from "effect"

import { Contract } from "@graftland/plugin-remote"

export const contract = Contract.make({
	name: "greeter",
	config: Schema.Struct({}),
	module: "./greeter.js",
})
