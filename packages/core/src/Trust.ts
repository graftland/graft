/** Atomic admission and a public boundary for operator policy plugins. */
import { Effect, type Scope } from "effect"

import type * as Graft from "./Graft"
import * as Internal from "./internal/trust"
import type {
	Authority,
	Projection,
	RegistrationError,
	Unapproved,
} from "./internal/trustModel"

export * from "./internal/trustModel"
/** Installs one authority before admission or projection publication. Closure fences all calls. */
export const register: (
	authority: Authority,
) => Effect.Effect<
	{ readonly close: Effect.Effect<void> },
	RegistrationError,
	Graft.Graft | Scope.Scope
> = (authority) => Internal.register(authority)
/** Publishes stable projection facts before a view exposes them. View withdrawal does not erase facts. */
export const publish: (
	values: ReadonlyArray<Projection>,
) => Effect.Effect<void, RegistrationError, Graft.Graft> = (values) =>
	Internal.publish(values)
/** Checks an attempt, or an unregistered caller when no candidate is supplied. Registered authorities reject unregistered callers. */
export const check: (
	entry: string,
	candidate?: string,
) => Effect.Effect<void, Unapproved, Graft.Graft> = (entry, candidate) =>
	Internal.check(entry, candidate)
