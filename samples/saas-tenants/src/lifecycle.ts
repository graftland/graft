import { Effect, Option, Stream } from "effect"

import type { Fork } from "@graftland/graft"

// Fork.await also settles at Pending; onboarding needs an accepting handler.
export const ready = <I, E>(fork: Fork.Fork<I, E>) =>
	fork.state.pipe(
		Stream.filter(
			(state) =>
				state._tag === "Active" ||
				state._tag === "Failed" ||
				state._tag === "Disposed",
		),
		Stream.runHead,
		Effect.flatMap((state) => {
			if (Option.isSome(state) && state.value._tag === "Failed")
				return Effect.failCause(state.value.cause)
			if (Option.isSome(state) && state.value._tag === "Active")
				return Effect.void
			return Effect.die(
				new Error(`Fork ${fork.id} stopped before becoming active`),
			)
		}),
	)
