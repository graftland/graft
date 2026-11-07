import { Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

// A plugin module exports its plugin as the default export. Importing the
// module must not start anything: Graft calls `apply` when it loads the entry.
export default Plugin.make({
	name: "@graftland/sample-config-file/greeter",
	config: Schema.Struct({ name: Schema.String }),
	apply: ({ name }) =>
		Effect.acquireRelease(Effect.log(`Hello, ${name}!`), () =>
			Effect.log(`Goodbye, ${name}!`),
		),
})
