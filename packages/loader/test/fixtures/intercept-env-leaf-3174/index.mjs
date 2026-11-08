import { Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Context.Reference(
	"@graftland/loader/test/intercept-env.test/Settings",
	{
		defaultValue: () => ({
			tags: [],
			label: "default",
		}),
	},
)
const State = Context.Service("loader/fixture/intercept-env-leaf-3174")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	apply: (...args) =>
		Effect.flatMap(State, ({ seen }) =>
			(() => Effect.flatMap(Settings, (value) => Ref.set(seen, value)))(
				...args,
			),
		),
})
