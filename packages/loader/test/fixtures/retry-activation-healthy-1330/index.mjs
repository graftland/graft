import { Context, Effect, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/retry-activation-healthy-1330")
export default Plugin.make({
	inject: [State],
	name: "healthy",
	config: Schema.Unknown,
	apply: (...args) =>
		Effect.flatMap(State, ({ healthyStarts, healthyUpdates }) =>
			(() =>
				Ref.update(healthyStarts, (n) => n + 1).pipe(
					Effect.as((_next) =>
						Ref.update(healthyUpdates, (n) => n + 1).pipe(Effect.as(true)),
					),
				))(...args),
		),
})
