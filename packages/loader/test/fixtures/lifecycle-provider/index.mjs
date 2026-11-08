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
const Dependency = Context.Service(
	"@graftland/loader/test/group-lifecycle.test/Dependency",
)
export default Plugin.make({
	name: "provider",
	provides: [Dependency],
	apply: () => Graft.provide(Dependency, "value"),
})
