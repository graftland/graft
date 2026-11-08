import { Array, Context, Deferred, Effect, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service(
	"@graftland/loader/test/reconciliation.test/State",
)
export default Plugin.make({
	inject: [State],
	name: "updatable",
	config: Schema.Finite,
	apply: () =>
		Effect.gen(function* () {
			const { entered, release, observed } = yield* State
			return (value) =>
				Effect.gen(function* () {
					if (value === 1) {
						yield* Deferred.succeed(entered, undefined)
						yield* Deferred.await(release)
					}
					yield* Ref.update(observed, Array.append(value))
					return true
				})
		}),
})
