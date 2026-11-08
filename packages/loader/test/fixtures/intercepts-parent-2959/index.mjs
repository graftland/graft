import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const emit = (name) =>
	Effect.gen(function* () {
		yield* Effect.logDebug(`${name}:debug`)
		yield* Effect.logInfo(`${name}:info`)
		yield* Effect.logWarning(`${name}:warn`)
	})
const State = Context.Service("loader/fixture/intercepts-parent-2959")
export default Plugin.make({
	inject: [State],
	name: "parent",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(State, ({ child }) =>
			((name) =>
				Effect.gen(function* () {
					yield* emit(name)
					const fork = yield* Graft.plugin(child, `${name}-child`)
					yield* fork.await
				}))(...args),
		),
})
