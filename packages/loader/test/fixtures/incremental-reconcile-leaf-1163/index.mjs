import { Array, Context, Effect, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/incremental-reconcile-leaf-1163")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(State, ({ observed }) =>
			((value) => Ref.update(observed, Array.append(value)))(...args),
		),
})
