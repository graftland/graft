import { Context, Deferred, Effect } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Context.Reference(
	"@graftland/loader/test/intercept.test/Settings",
	{ defaultValue: () => ({ color: "blue", size: 12 }) },
)
const State = Context.Service("loader/fixture/intercept-settings-6225")
export default Plugin.make({
	inject: [State],
	name: "settings",
	apply: (...args) =>
		Effect.flatMap(State, ({ observed }) =>
			(() =>
				Effect.flatMap(Settings, (settings) =>
					Deferred.succeed(observed, settings).pipe(Effect.asVoid),
				))(...args),
		),
})
