import { Context, Effect, Option, SubscriptionRef } from "effect"

/**
 * Outstanding refresh work, including activation waiters and executing
 * requests. The loader's `ready` waits until none are left.
 */
export const PendingRefreshes = Context.Reference<
	Option.Option<SubscriptionRef.SubscriptionRef<number>>
>("@graftland/loader/internal/pending/PendingRefreshes", {
	defaultValue: () => Option.none(),
})

/** Counts the effect as a pending refresh while it runs. */
export const track = <A, E, R>(
	pending: Option.Option<SubscriptionRef.SubscriptionRef<number>>,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Option.match(pending, {
		onNone: () => effect,
		onSome: (count) =>
			Effect.acquireUseRelease(
				SubscriptionRef.update(count, (n) => n + 1),
				() => effect,
				() => SubscriptionRef.update(count, (n) => n - 1),
			),
	})
