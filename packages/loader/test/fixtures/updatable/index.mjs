import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Option,
	Ref,
	Schema,
} from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group, Include, Loader } from "@graftland/loader"

const Journal = Context.Service("@graftland/loader/test/utils/JournalService")
export default Plugin.make({
	name: "updatable",
	config: Schema.String,
	apply: (value) =>
		Effect.gen(function* () {
			const journal = yield* Journal
			yield* journal.record(`start ${value}`)
			return (next) => Effect.as(journal.record(`update ${next}`), true)
		}),
})
