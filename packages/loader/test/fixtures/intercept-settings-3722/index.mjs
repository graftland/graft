import { Context, Deferred, Effect } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Context.Reference(
	"@graftland/loader/test/intercept.test/Settings",
	{ defaultValue: () => ({ color: "blue", size: 12 }) },
)
const State = Context.Service("loader/fixture/intercept-settings-3722")
export default Plugin.make({
	inject: [State],
	name: "settings",
	apply: (...args) =>
		Effect.flatMap(State, ({ observed }) =>
			(() =>
				Effect.flatMap(Settings, (value) =>
					Deferred.succeed(observed, value).pipe(Effect.asVoid),
				))(...args),
		),
})
