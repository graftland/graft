import { Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/otlp-counted-5324")
export default Plugin.make({
	inject: [State],
	name: "counted",
	apply: (...args) =>
		Effect.flatMap(State, ({ starts }) =>
			(() => Ref.update(starts, (count) => count + 1))(...args),
		),
})
