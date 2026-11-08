import { Context, Deferred, Effect } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/regressions-worker-4534")
export default Plugin.make({
	inject: [State],
	name: "worker",
	apply: (...args) =>
		Effect.flatMap(State, ({ started, finish, completed }) =>
			(() =>
				Plugin.fork(
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(finish)),
						Effect.withSpan("across-swap"),
						Effect.andThen(Deferred.succeed(completed, undefined)),
					),
				).pipe(Effect.asVoid))(...args),
		),
})
