import { Effect } from "effect"

import { Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "test/other",
	apply: () => Effect.void,
})
