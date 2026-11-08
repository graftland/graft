import { Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "recorded-business",
	config: Schema.Struct({ version: Schema.Int }),
	apply: () => Effect.void,
})
