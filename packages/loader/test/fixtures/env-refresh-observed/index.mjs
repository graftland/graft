import { Array, Context, Effect, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const Setting = Context.Reference(
	"@graftland/loader/test/env-refresh.test/Setting",
	{ defaultValue: () => "default" },
)
const State = Context.Service("loader/env-refresh-observed")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.String,
	apply: (value) =>
		Effect.gen(function* () {
			const { observed } = yield* State
			const setting = yield* Setting
			yield* Ref.update(observed, Array.append(`${value}/${setting}`))
		}),
})
