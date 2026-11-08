import { Array, Context, Effect, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const Setting = Context.Reference(
	"@graftland/loader/test/intercept-env.test/Setting",
	{ defaultValue: () => "default" },
)
const State = Context.Service("loader/fixture/intercept-env-leaf-1214")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(State, ({ observations }) =>
			((config) =>
				Effect.flatMap(Setting, (setting) =>
					Ref.update(observations, Array.append({ config, setting })),
				))(...args),
		),
})
