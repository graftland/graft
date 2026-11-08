import { Context, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/retry-activation-flaky-1330")
export default Plugin.make({
	inject: [State],
	name: "flaky",
	apply: (...args) =>
		Effect.flatMap(State, ({ attempts, available }) =>
			(() =>
				Effect.gen(function* () {
					yield* Ref.update(attempts, (n) => n + 1)
					if (!(yield* Ref.get(available)))
						return yield* Effect.fail("Temporarily unavailable")
				}))(...args),
		),
})
