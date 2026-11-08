/** Embedded lifecycle guards. Kernel execution uses data-only unit control. */
import { Context, Effect, Option, Schema, type Cause, type Exit } from "effect"

import type { Fork } from "./Fork"
import type * as Graft from "./Graft"
import * as Guard from "./internal/unitGuard"
import type { Plugin } from "./Plugin"

export const CurrentInstance = Context.Reference<Option.Option<string>>(
	"@graftland/graft/Transition/CurrentInstance",
	{ defaultValue: Option.none },
)
/** Fixed membership granted when an execution unit creates its embedded runtime. */
export const UnitMember = Context.Reference<Option.Option<string>>(
	"@graftland/graft/Transition/UnitMember",
	{ defaultValue: Option.none },
)
/** Unit-local lifecycle transport. The kernel grants each activation before plugin execution. */
export interface MemberLifecycle {
	readonly isolate: Graft.PluginOptions["isolate"]
	readonly environment: Context.Context<never>
	readonly expose: (context: Context.Context<unknown>) => Effect.Effect<void>
	readonly instance: string
	readonly acquire: Effect.Effect<number>
	readonly failed: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
	readonly stopped: (exit: Exit.Exit<void, unknown>) => Effect.Effect<void>
	readonly attached: (fork: Fork) => Effect.Effect<void>
}
/** Infrastructure rebuilt inside the execution unit, distinct from application provisions. */
export const Environment = Context.Reference<Context.Context<never>>(
	"@graftland/graft/Transition/Environment",
	{ defaultValue: Context.empty },
)
export interface MemberRegistry {
	readonly open: (
		plugin: Plugin,
		input: unknown,
		declaration: Option.Option<string>,
		parent: Option.Option<string>,
	) => Effect.Effect<MemberLifecycle>
}
export const Registry = Context.Reference<Option.Option<MemberRegistry>>(
	"@graftland/graft/Transition/Registry",
	{ defaultValue: Option.none },
)
export const Lifecycle = Context.Reference<Option.Option<MemberLifecycle>>(
	"@graftland/graft/Transition/Lifecycle",
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
