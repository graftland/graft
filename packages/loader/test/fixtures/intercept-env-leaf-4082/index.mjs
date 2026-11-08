import { Array, Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const Setting = Context.Reference(
	"@graftland/loader/test/intercept-env.test/Setting",
	{ defaultValue: () => "default" },
)
const State = Context.Service("loader/fixture/intercept-env-leaf-4082")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	apply: (...args) =>
		Effect.flatMap(State, ({ observed }) =>
			(() =>
				Effect.flatMap(Setting, (value) =>
					Ref.update(observed, Array.append(value)),
				))(...args),
		),
})
