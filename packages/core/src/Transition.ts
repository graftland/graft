/** Single-fork, stateless transitions and execution-driver extension points. */
import {
	Context,
	Effect,
	Option,
	Schema,
	type Duration,
	type Scope,
} from "effect"

import type * as Change from "./Change"
import * as Graft from "./Graft"
import * as Coordinator from "./internal/transition"
import type { OperationIdentity } from "./Plugin"
import type { Unapproved } from "./Trust"

/** Loader binds this reference to its entry id. Embedded registrations name themselves. */
export const CurrentInstance = Context.Reference<Option.Option<string>>(
	"@graftland/graft/Transition/CurrentInstance",
	{ defaultValue: Option.none },
)

export class DriverError extends Schema.TaggedError<
	DriverError,
	{ readonly brand: unique symbol }
>()("DriverError", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

export class Unavailable extends Schema.TaggedError<
	Unavailable,
	{ readonly brand: unique symbol }
>()("Unavailable", {
	fork: Schema.Finite,
}) {}

/** A call can be rejected before a generation is selected. */
export const CallRejection = Schema.TaggedUnion({
	Limit: { attempt: Schema.Finite, limit: Schema.Finite },
	QueueOverflow: { limit: Schema.Finite },
	QueueExpired: {},
	Closing: {},
	RecoveryFailed: {},
})
export type CallRejection = typeof CallRejection.Type
export class AdmissionRejected extends Schema.TaggedError<
	AdmissionRejected,
	{ readonly brand: unique symbol }
>()("AdmissionRejected", {
	fork: Schema.Finite,
	reason: CallRejection,
}) {}

/** A bypass would replace a coordinator-owned fork or one of its ancestors. */
export class ManagedFork extends Schema.TaggedError<
	ManagedFork,
	{ readonly brand: unique symbol }
>()("ManagedFork", {
	fork: Schema.Finite,
}) {}

export interface Description {
	readonly overlap: boolean
	readonly provides: ReadonlyArray<OperationIdentity>
}

/** Correlation fixed before allocation and echoed by the unit's lifecycle observations. */
export interface Allocation {
	readonly change: Option.Option<Change.Id>
	readonly generation: number
	readonly routeVersion: number
	readonly term: number
}

/** Lifecycle primitives only. Exiting is independent of transport or scope closure. */
export interface Unit {
	readonly acknowledgement: Allocation
	readonly start: Effect.Effect<void, DriverError, Scope.Scope>
	readonly describe: Effect.Effect<Description, DriverError>
	readonly serve: Effect.Effect<void, DriverError>
	readonly ready: Effect.Effect<Context.Context<never>, DriverError>
	readonly probe: (name: string) => Effect.Effect<void, DriverError>
	readonly stop: Effect.Effect<void, DriverError>
	readonly terminate: Effect.Effect<void, DriverError>
	readonly exited: Effect.Effect<Change.Termination, DriverError>
	readonly failure: Effect.Effect<never, DriverError>
}

/** Verified deployment facts available before execution. */
export interface Prepared {
	readonly overlap: boolean
}
/** Allocation owns resources in the attempt scope. Execution starts only in Unit.start. */
export interface Driver {
	readonly name: string
	/** Immutable resource selection; deferred credentials must not change this footprint. */
	readonly footprint?: ((candidate: Change.Candidate) => unknown) | undefined
	/** Verifies metadata without executing the plugin or acquiring exclusive execution resources. */
	readonly prepare?:
		| ((
				candidate: Change.Candidate,
		  ) => Effect.Effect<Prepared, DriverError, Scope.Scope>)
		| undefined
	/** Verified from the immutable deployment before allocation or execution. */
	readonly overlap?: ((candidate: Change.Candidate) => boolean) | undefined
	readonly allocate: (
		candidate: Change.Candidate,
		attempt: number,
		allocation: Allocation,
	) => Effect.Effect<Unit, DriverError, Scope.Scope>
}

/** Selection and admission happen when the returned Effect executes. */
export interface Invoke {
	<I, S, A, E, R>(
		key: Context.Key<I, S>,
		use: (service: S) => Effect.Effect<A, E, R>,
	): Effect.Effect<
		A,
		E | Unavailable | DriverError | AdmissionRejected | Unapproved,
		R
	>
}

export interface Facade {
	readonly key: string
	readonly publish: (
		invoke: Invoke,
	) => Effect.Effect<void, Graft.ServiceConflict, Graft.Graft>
}

/** Builds a service object once; its methods dispatch through the fork's route. */
export const facade = <I, S>(
	key: Context.Key<I, S>,
	make: (
		invoke: <A, E, R>(
			use: (service: S) => Effect.Effect<A, E, R>,
		) => Effect.Effect<
			A,
			E | Unavailable | DriverError | AdmissionRejected | Unapproved,
			R
		>,
	) => S,
): Facade => ({
	key: key.key,
	publish: (invoke) =>
		Graft.provide(
			key,
			make((use) => invoke(key, use)),
		),
})

export interface Registration {
	/** Required for embedded use; Loader supplies and binds its entry id. */
	readonly instance?: string | undefined
	/** Positive per-attempt admission limit. Defaults to 256. */
	readonly maxInFlight?: number | undefined
	readonly initial: Change.Candidate
	readonly required: ReadonlyArray<OperationIdentity>
	readonly facades: ReadonlyArray<Facade>
	readonly budget?: Partial<Change.Budget> | undefined
	readonly requirements?: Partial<Change.Requirements> | undefined
	/** Re-resolves desired input before every allocation, including recovery. */
	readonly resolve?:
		| ((
				desired: Change.Candidate,
		  ) => Effect.Effect<Change.Candidate, DriverError>)
		| undefined
	readonly queue?:
		| {
				readonly maxWaiters?: number
				readonly maxWait?: Duration.Input
		  }
		| undefined
}

/** Registers a driver for the current fork, owned by the registration scope, and starts its first attempt. */
export const registerDriver: (
	driver: Driver,
	registration: Registration,
) => Effect.Effect<
	void,
	DriverError | Graft.ServiceConflict,
	Graft.Graft | Scope.Scope
> = (driver, registration) => Coordinator.register(driver, registration)

/** Rejects edits before persistence or cache mutation. Ancestors include all managed descendants. */
export const assertUnmanaged: (
	fork?: number,
) => Effect.Effect<void, ManagedFork, Graft.Graft> = (fork) =>
	Coordinator.assertUnmanaged(fork)

/** Holds bypass admission through an external mutation; driver registration cannot race it. */
export const withUnmanaged = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	fork?: number,
): Effect.Effect<A, E | ManagedFork, R | Graft.Graft> =>
	Coordinator.withUnmanaged(effect, fork)
