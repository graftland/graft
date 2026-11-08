import { Array, Context, Effect, Option, Ref } from "effect"

import { Plugin } from "@graftland/graft"
import { Entry } from "@graftland/loader"

const State = Context.Service("loader/fixture/include-entry-lists-child-3751")
export default Plugin.make({
	inject: [State],
	name: "child",
	apply: (...args) =>
		Effect.flatMap(State, ({ ids }) =>
			(() =>
				Effect.flatMap(Entry.CurrentId, (id) =>
					Ref.update(ids, Array.append(Option.getOrThrow(id))),
				))(...args),
		),
})
