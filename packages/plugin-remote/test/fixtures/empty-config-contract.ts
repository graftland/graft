import { Schema } from "effect"

import { Contract } from "../../src/index"

export const contract = Contract.make({
	name: "empty-config",
	config: Schema.Struct({}),
})
