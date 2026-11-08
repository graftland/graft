import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

export default Plugin.make({
	name: "host",
	config: Schema.Struct({ plugins: Entry.Entries }),
	apply: (...args) =>
		Effect.flatMap(
			Context.Service("@graftland/loader/test/utils/JournalService"),
			(journal) =>
				Effect.fnUntraced(function* ({ plugins }) {
					const subtree = yield* Graft.plugin(Group.Group, plugins)
					return (next) => subtree.update(next.plugins).pipe(Effect.as(true))
				})(...args),
		),
})
