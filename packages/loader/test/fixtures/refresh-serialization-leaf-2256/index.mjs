import { Array, Context, Deferred, Effect, Ref, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/refresh-serialization-leaf-2256")
export default Plugin.make({
	inject: [State],
	name: "leaf",
	config: Schema.String,
	apply: (...args) =>
		Effect.flatMap(
			State,
			({ journal, laterStarted, updating, releaseUpdate, cancelled }) =>
				((value) =>
					Effect.gen(function* () {
						yield* Ref.update(journal, Array.append(`start ${value}`))
						if (value === "c") yield* Deferred.succeed(laterStarted, undefined)
						return (value) =>
							Effect.gen(function* () {
								yield* Ref.update(journal, Array.append(`begin ${value}`))
								if (value === "b") {
									yield* Deferred.succeed(updating, undefined)
									yield* Deferred.await(releaseUpdate).pipe(
										Effect.onInterrupt(() =>
											Deferred.succeed(cancelled, undefined),
										),
									)
								}
								if (value === "c")
									yield* Deferred.succeed(laterStarted, undefined)
								yield* Ref.update(journal, Array.append(`end ${value}`))
								return true
							})
					}))(...args),
		),
})
