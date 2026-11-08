import { Context, Effect, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/group-cleanup-changing-4156")
export default Plugin.make({
	inject: [State],
	name: "changing",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(State, ({ broken, cleanup }) =>
			(() =>
				Effect.addFinalizer(() =>
					Ref.get(broken).pipe(
						Effect.flatMap((broken) =>
							broken ? Effect.die(cleanup) : Effect.void,
						),
					),
				).pipe(Effect.as(() => Effect.succeed(false))))(...args),
		),
})
