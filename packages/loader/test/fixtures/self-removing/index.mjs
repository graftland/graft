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
	name: "self",
	inject: [Loader.Loader],
	apply: () => Effect.flatMap(Loader.Loader, (loader) => loader.remove("self")),
})
