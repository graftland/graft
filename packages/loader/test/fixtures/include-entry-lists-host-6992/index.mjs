import { Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

export default Plugin.make({
	name: "host",
	config: Schema.Struct({ plugins: Schema.Array(Entry.NewEntry) }),
	apply: ({ plugins }) =>
		Graft.plugin(Group.Group, plugins).pipe(Effect.asVoid),
})
