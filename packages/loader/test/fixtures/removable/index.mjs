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
	name: "removable",
	inject: [Loader.Loader],
	apply: () =>
		Effect.gen(function* () {
			const loader = yield* Loader.Loader
			yield* Effect.addFinalizer(() =>
				loader
					.create({ id: "created", name: "unused", disabled: true })
					.pipe(Effect.orDie),
			)
		}),
})
