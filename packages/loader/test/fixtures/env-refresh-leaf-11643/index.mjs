import { Context, Deferred, Effect, HashMap, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/env-refresh-leaf-11643")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.Struct({ id: Schema.String, value: Schema.String }),
	apply: (...args) =>
		Effect.flatMap(State, ({ latest, started }) =>
			(({ id, value }) =>
				Ref.update(latest, HashMap.set(id, value)).pipe(
					Effect.andThen(Deferred.succeed(started, undefined)),
					Effect.asVoid,
				))(...args),
		),
})
