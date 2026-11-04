import { Plugin } from "@graftland/graft"
import { Effect } from "effect"

export default Plugin.make({
	name: "empty-implementation",
	apply: () => Effect.void,
})
