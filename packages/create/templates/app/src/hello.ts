import { Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

// Module evaluation only defines the plugin; its activation owns all resources.
export default Plugin.make({
	name: "{{package}}/hello",
	config: Schema.Struct({ message: Schema.String }),
	apply: ({ message }) =>
		Effect.acquireRelease(Effect.logInfo(message), () =>
			Effect.logInfo("Hello plugin stopped"),
		),
})
