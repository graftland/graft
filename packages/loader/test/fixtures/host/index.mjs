import { Context, Effect, Option, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

class Journal extends Context.Service()(
	"@graftland/loader/test/utils/JournalService",
) {}
export default Plugin.make({
	name: "host",
	config: Schema.Struct({ plugins: Entry.Entries }),
	apply: ({ plugins }) =>
		Graft.plugin(Group.Group, plugins).pipe(Effect.asVoid),
})
