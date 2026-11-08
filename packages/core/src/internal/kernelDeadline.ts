import { Effect } from "effect"

/** A platform sleep may round down; report time only after observing the deadline. */
export const waitUntil = Effect.fnUntraced(function* (
	now: Effect.Effect<number>,
	deadline: number,
): Effect.fn.Return<number> {
	const observed = yield* now
	if (observed >= deadline) return observed
	yield* Effect.sleep(deadline - observed)
	return yield* waitUntil(now, deadline)
})
