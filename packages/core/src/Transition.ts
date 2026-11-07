/** Embedded lifecycle guards. Kernel execution uses data-only unit control. */
import { Context, Effect, Option, Schema } from "effect"

import type * as Graft from "./Graft"
import * as Guard from "./internal/unitGuard"

export const CurrentInstance = Context.Reference<Option.Option<string>>(
	"@graftland/graft/Transition/CurrentInstance",
	{ defaultValue: Option.none },
)
/** Fixed membership granted when an execution unit creates its embedded runtime. */
export const UnitMember = Context.Reference<Option.Option<string>>(
	"@graftland/graft/Transition/UnitMember",
	{ defaultValue: Option.none },
)
export class ManagedFork extends Schema.TaggedError<
	ManagedFork,
	{ readonly brand: unique symbol }
>()("ManagedFork", { fork: Schema.Finite }) {}
export const assertUnmanaged: (
	fork?: number,
) => Effect.Effect<void, ManagedFork, Graft.Graft> = (fork) =>
	Guard.assertUnmanaged(fork)
export const withUnmanaged = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	fork?: number,
): Effect.Effect<A, E | ManagedFork, R | Graft.Graft> =>
	Guard.withUnmanaged(effect, fork)
