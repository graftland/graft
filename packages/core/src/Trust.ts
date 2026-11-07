/** Operator-owned artifact approvals; no package declares its own trust. */
import { Effect, type Scope } from "effect"

import type * as Graft from "./Graft"
import * as Internal from "./internal/trust"
import type {
	Approval,
	Approve,
	Assignment,
	Description,
	Identity,
	Policy,
	PolicyError,
	Statement,
	Unapproved,
} from "./internal/trustModel"

export * from "./internal/trustModel"

/** Installs one policy owner. Closing it fences governed calls; it never restores open access. */
export const install: (
	policy: Policy,
	approvals?: ReadonlyArray<Approval>,
	revocations?: ReadonlyArray<string>,
) => Effect.Effect<void, PolicyError, Graft.Graft | Scope.Scope> = (...args) =>
	Internal.install(...args)
/** Validates a driver's independently verified artifact and binds its facade service keys. */
export const bind: (
	entry: string,
	candidate: string,
	identity: Identity,
	services: ReadonlyArray<string>,
) => Effect.Effect<
	Assignment | undefined,
	Unapproved | PolicyError,
	Graft.Graft
> = (...args) => Internal.bind(...args)
export const statement: (
	entry: string,
	identity: Identity,
) => Effect.Effect<Statement, Unapproved, Graft.Graft> = (...args) =>
	Internal.statement(...args)
/** Compares exact metadata before publishing a changed view. */
export const describe: (
	owner: object,
	descriptions: ReadonlyArray<Description>,
) => Effect.Effect<void, PolicyError, Graft.Graft | Scope.Scope> = (...args) =>
	Internal.describe(...args)
/** Checks the same state read by facade admission; brokers call it for every request. */
export const check: (
	entry: string,
	candidate: string,
) => Effect.Effect<void, Unapproved, Graft.Graft> = (...args) =>
	Internal.check(...args)
export const review: (
	request: Approve,
) => Effect.Effect<Approval, Unapproved, Graft.Graft> = (...args) =>
	Internal.review(...args)
/** Install only after the approval has been durably journaled. */
export const approve: (
	record: Approval,
) => Effect.Effect<void, Unapproved, Graft.Graft> = (...args) =>
	Internal.approve(...args)
/** Atomically fences grants before asking their owners for independently confirmed exit. */
export const revoke: (
	references: ReadonlyArray<string>,
) => Effect.Effect<void, PolicyError, Graft.Graft> = (...args) =>
	Internal.revoke(...args)
export const onRevoke: (
	entry: string,
	candidate: string,
	terminate: Effect.Effect<void, PolicyError>,
) => Effect.Effect<void, PolicyError, Graft.Graft | Scope.Scope> = (...args) =>
	Internal.onRevoke(...args)
export const statements: Effect.Effect<
	ReadonlyArray<Statement>,
	never,
	Graft.Graft
> = Effect.suspend(() => Internal.statements)

/** Withdraws one scoped projection from the current approval statement. */
export const withdraw: (
	owner: object,
) => Effect.Effect<void, never, Graft.Graft> = (...args) =>
	Internal.withdraw(...args)

export const enabled: Effect.Effect<boolean, never, Graft.Graft> =
	Effect.suspend(() => Internal.enabled)
