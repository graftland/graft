import { Context, Effect } from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/fixture/group-cleanup-broken-1435")
export default Plugin.make({
	inject: [State],
	name: "broken",
	apply: (...args) =>
		Effect.flatMap(
			Context.Service("@graftland/loader/test/utils/JournalService"),
			(journal) =>
				((...args) =>
					Effect.flatMap(State, ({ first, second }) =>
						(() =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => Effect.die(first))
								yield* Effect.addFinalizer(() => Effect.die(second))
								yield* journal.record("start broken")
							}))(...args),
					))(...args),
		),
})
