import { Context, Deferred, Effect } from "effect"

import { Plugin } from "@graftland/graft"

const formal = Context.Reference(
	"@graftland/loader/test/intercept.test/formal",
	{ defaultValue: () => false },
)
const State = Context.Service("loader/fixture/intercept-formal-5098")
export default Plugin.make({
	inject: [State],
	name: "formal",
	apply: (...args) =>
		Effect.flatMap(State, ({ observed }) =>
			(() =>
				Effect.flatMap(formal, (value) =>
					Deferred.succeed(observed, value).pipe(Effect.asVoid),
				))(...args),
		),
})
