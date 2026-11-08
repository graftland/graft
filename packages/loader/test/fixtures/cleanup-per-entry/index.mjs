import { Context, Effect } from "effect"

import { Plugin } from "@graftland/graft"
import { Entry } from "@graftland/loader"

const State = Context.Service("loader/cleanup-per-entry")
export default Plugin.make({
	inject: [State],
	name: "broken",
	apply: () =>
		Effect.gen(function* () {
			const { first, second } = yield* State
			const id = yield* Entry.CurrentId
			const failure =
				id._tag === "Some" && id.value === "first" ? first : second
			yield* Effect.addFinalizer(() => Effect.die(failure))
		}),
})
