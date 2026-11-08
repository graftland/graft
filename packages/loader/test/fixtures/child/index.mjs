import { Context, Effect, Option, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

class Journal extends Context.Service()(
	"@graftland/loader/test/utils/JournalService",
) {}
export default Plugin.make({
	name: "child",
	config: Schema.Struct({ message: Schema.String }),
	inject: [Journal],
	apply: ({ message }) =>
		Effect.flatMap(Journal, (journal) => journal.record(message)),
})
