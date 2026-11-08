import { Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/extensions-worker-8451")
export default Plugin.make({
	inject: [State],
	name: "test/worker",
	apply: (...args) =>
		Effect.flatMap(State, ({ starts }) =>
			(() => Ref.update(starts, (n) => n + 1))(...args),
		),
})
