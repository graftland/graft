import { Context, Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

class Journal extends Context.Service()(
	"@graftland/loader/test/utils/JournalService",
) {}

export default Plugin.make({
	name: "echo",
	config: Schema.Struct({ text: Schema.String }),
	inject: [Journal],
	apply: ({ text }) =>
		Effect.flatMap(Journal, (journal) =>
			Effect.acquireRelease(journal.record(`start ${text}`), () =>
				journal.record(`stop ${text}`),
			),
		),
})
