import { Context, Effect, Option, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

class Journal extends Context.Service()(
	"@graftland/loader/test/utils/JournalService",
) {}
export default Plugin.make({
	name: "reporter",
	inject: [Journal],
	apply: () =>
		Effect.gen(function* () {
			const journal = yield* Journal
			const id = yield* Entry.CurrentId
			yield* journal.record(Option.getOrElse(id, () => "none"))
		}),
})
