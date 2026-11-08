import { Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/intercepts-probe-5031")
export default Plugin.make({
	inject: [State],
	name: "probe",
	apply: (...args) =>
		Effect.flatMap(State, ({ started }) =>
			(() => Ref.set(started, true))(...args),
		),
})
