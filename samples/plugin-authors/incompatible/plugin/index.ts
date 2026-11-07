import { Effect } from "effect"

import { Plugin } from "@graftland/graft"

import { Service } from "@alice/conformance-echo-contract"

export default Plugin.make({
	name: "@incompatible/plugin",
	inject: [Service],
	apply: () => Effect.die("Preflight must reject before activation"),
})
