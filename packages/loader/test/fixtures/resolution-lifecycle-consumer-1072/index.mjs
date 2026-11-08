import { Context, Deferred, Effect } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Context.Reference(
	"@graftland/loader/test/resolution-lifecycle/Settings",
	{
		defaultValue: () => "default",
	},
)
const State = Context.Service(
	"loader/fixture/resolution-lifecycle-consumer-1072",
)
export default Plugin.make({
	inject: [State],
	name: "consumer",
	apply: (...args) =>
		Effect.flatMap(State, ({ observed }) =>
			(() =>
				Effect.flatMap(Settings, (value) =>
					Deferred.succeed(observed, value),
				).pipe(Effect.asVoid))(...args),
		),
})
