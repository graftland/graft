import { Context, Deferred, Effect } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/serialization-worker-2874")
export default Plugin.make({
	inject: [State],
	name: "test/worker",
	apply: (...args) =>
		Effect.flatMap(State, ({ traced }) =>
			(() =>
				Effect.void.pipe(
					Effect.withSpan("serialization-fixture"),
					Effect.andThen(Deferred.succeed(traced, undefined)),
					Effect.asVoid,
				))(...args),
		),
})
