/** Atomic admission and a public boundary for operator policy plugins. */
import { Context, Effect, type Scope } from "effect"

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
/** Retrieves services owned by the registered policy plugin. */
export const service: <I, A>(
	key: Context.Key<I, A>,
) => Effect.Effect<A, RegistrationError, Graft.Graft> = (key) =>
	Internal.service(key)
/** Publishes stable projection facts before a view exposes them. View withdrawal does not erase facts. */
export const publish: (
	values: ReadonlyArray<Projection>,
) => Effect.Effect<void, RegistrationError, Graft.Graft> = (values) =>
	Internal.publish(values)
export const check: (
	entry: string,
	candidate: string,
) => Effect.Effect<void, Unapproved, Graft.Graft> = (entry, candidate) =>
	Internal.check(entry, candidate)
export const enabled: Effect.Effect<boolean, never, Graft.Graft> =
	Effect.suspend(() => Internal.enabled)
