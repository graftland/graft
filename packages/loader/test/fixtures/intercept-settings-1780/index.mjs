import { Array, Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Context.Reference(
	"@graftland/loader/test/intercept.test/Settings",
	{ defaultValue: () => ({ color: "blue", size: 12 }) },
)
const State = Context.Service("loader/fixture/intercept-settings-1780")
export default Plugin.make({
	inject: [State],
	name: "settings",
	apply: (...args) =>
		Effect.flatMap(State, ({ values }) =>
			(() =>
				Effect.flatMap(Settings, (value) =>
					Ref.update(values, Array.append(value)),
				))(...args),
		),
})
