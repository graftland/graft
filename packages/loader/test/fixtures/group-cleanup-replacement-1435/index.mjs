import { Context, Effect } from "effect"

import { Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "replacement",
	apply: (...args) =>
		Effect.flatMap(
			Context.Service("@graftland/loader/test/utils/JournalService"),
			(journal) => (() => journal.record("start replacement"))(...args),
		),
})
