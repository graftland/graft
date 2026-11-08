import { Context, Effect, Queue, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const Setting = Context.Reference(
	"@graftland/loader/test/env-refresh.test/Setting",
	{ defaultValue: () => "default" },
)
const State = Context.Service("loader/fixture/env-refresh-leaf-4702")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(State, ({ starts }) =>
			((value) =>
				Effect.flatMap(Setting, (setting) =>
					Effect.asVoid(Queue.offer(starts, `${value}/${setting}`)),
				))(...args),
		),
})
