import { Context, Effect, Option, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

class Journal extends Context.Service()(
	"@graftland/loader/test/utils/JournalService",
) {}
export default Plugin.make({
	name: "observer",
	config: Schema.Struct({
		name: Schema.Literal("unused"),
		disabled: Schema.Literal(true),
	}),
	inject: [Journal],
	apply: () =>
		Effect.flatMap(Journal, (journal) =>
			Effect.acquireRelease(journal.record("start observer"), () =>
				journal.record("stop observer"),
			),
		),
})
