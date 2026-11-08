import { Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "consumer",
	config: Schema.Unknown,
	apply: () => Effect.void,
})
