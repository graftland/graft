import { Context, Deferred, Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/incremental-reconcile-leaf-5323")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(State, ({ first, second }) =>
			((id) =>
				Effect.addFinalizer(() =>
					Deferred.succeed(id === "first" ? first : second, undefined).pipe(
						Effect.andThen(Deferred.await(id === "first" ? second : first)),
					),
				))(...args),
		),
})
