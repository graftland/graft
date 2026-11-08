import { Effect } from "effect"

import { Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "settings",
	apply: () => Effect.die("The invalid entry must not start"),
})
