/** Atomic admission and a public boundary for operator policy plugins. */
import { Effect, type Scope } from "effect"

import type * as Graft from "./Graft"
import * as Internal from "./internal/trust"
import type {
	AdmissionRegistrationError,
	Authority,
	ProjectionConflict,
	Publication,
	Publisher,
	Unapproved,
} from "./internal/trustModel"

export * from "./internal/trustModel"
/** Installs one authority before admission or projection publication. Closure fences all calls. */
export const register: (
	authority: Authority,
) => Effect.Effect<
	{ readonly close: Effect.Effect<void> },
	AdmissionRegistrationError,
	Graft.Graft | Scope.Scope
> = (authority) => Internal.register(authority)
/** Claims a logical view for this scope and publishes its initial facts. Withdrawal retains the latest facts. */
export const publish: (
	publication: Publication,
) => Effect.Effect<
	Publisher,
	AdmissionRegistrationError | ProjectionConflict,
	Graft.Graft | Scope.Scope
> = (publication) => Internal.publish(publication)
/** Checks an attempt of an instance, or an unregistered caller when no attempt is supplied. Registered authorities reject unregistered callers. */
export const check: (
	instance: string,
	attempt?: string,
) => Effect.Effect<void, Unapproved, Graft.Graft> = (instance, attempt) =>
	Internal.check(instance, attempt)
