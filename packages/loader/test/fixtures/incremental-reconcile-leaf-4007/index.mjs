import { Context, Deferred, Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/incremental-reconcile-leaf-4007")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(State, ({ slow, fast, release }) =>
			((id) =>
				Effect.succeed((_next) =>
					Deferred.succeed(id === "slow" ? slow : fast, undefined).pipe(
						Effect.andThen(
							id === "slow" ? Deferred.await(release) : Effect.void,
						),
						Effect.as(true),
					),
				))(...args),
		),
})
