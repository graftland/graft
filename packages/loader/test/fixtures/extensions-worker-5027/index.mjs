import { Array, Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/extensions-worker-5027")
export default Plugin.make({
	inject: [State],
	name: "test/worker",
	apply: (...args) =>
		Effect.flatMap(State, ({ starts, output }) =>
			Effect.fnUntraced(function* () {
				yield* Ref.update(starts, (n) => n + 1)
				yield* Effect.addFinalizer(() =>
					Ref.update(output.journal, Array.append("stop")),
				)
			})(...args),
		),
})
