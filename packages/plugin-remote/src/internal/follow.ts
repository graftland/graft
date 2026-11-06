import { Effect, Stream, type Cause, type Schema } from "effect"

import {
	Plugin,
	type Fork,
	type Graft,
	type Transition,
} from "@graftland/graft"

/** Follow startup and later failures without changing the caller's error boundary. */
export const follow = Effect.fnUntraced(function* <I, E, F>(
	fork: Fork.Fork<I, E>,
	fail: (
		cause: Cause.Cause<E | Schema.SchemaError | Transition.ManagedFork>,
	) => Effect.Effect<never, F>,
): Effect.fn.Return<void, F, Graft.Graft | Plugin.Tasks<F>> {
	yield* fork.await.pipe(Effect.catchCause(fail))
	yield* Plugin.fork(
		fork.state.pipe(
			Stream.runForEach((state) =>
				state._tag === "Failed" ? fail(state.cause) : Effect.void,
			),
		),
	)
})
