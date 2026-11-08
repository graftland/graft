import { Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/intercept-env-leaf-7537")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	apply: (...args) =>
		Effect.flatMap(State, ({ started }) =>
			(() => Ref.set(started, true))(...args),
		),
})
