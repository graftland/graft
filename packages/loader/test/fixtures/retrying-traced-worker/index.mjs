import { Context, Deferred, Effect, Ref } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("otlp/retrying-traced-worker")
export default Plugin.make({
	inject: [State],
	name: "test/retryWorker",
	apply: () =>
		Effect.gen(function* () {
			const { attempts, starts, started, stopped, recovered } = yield* State
			yield* Ref.update(starts, (n) => n + 1)
			yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined))
			yield* Deferred.succeed(started, undefined)
			if ((yield* Ref.get(attempts)) === 2)
				yield* Deferred.succeed(recovered, undefined)
		}),
})
