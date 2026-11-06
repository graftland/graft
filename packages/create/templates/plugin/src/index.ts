import { Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

// Module evaluation only defines the plugin; its activation owns all resources.
export default Plugin.make({
	name: "{{package}}",
	config: Schema.Struct({ name: Schema.String }),
	apply: ({ name }) =>
		Effect.acquireRelease(Effect.logInfo(`Hello, ${name}!`), () =>
			Effect.logInfo(`Goodbye, ${name}!`),
		),
})
