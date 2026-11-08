import { Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/regressions-worker-6106")
export default Plugin.make({
	inject: [State],
	name: "worker",
	apply: (...args) =>
		Effect.flatMap(State, ({ starts }) =>
			(() => Ref.update(starts, (count) => count + 1))(...args),
		),
})
