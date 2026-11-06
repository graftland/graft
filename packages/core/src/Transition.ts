/** Single-fork, stateless transitions and execution-driver extension points. */
import { Context, Effect, Schema, type Cause, type Scope } from "effect"

import * as Graft from "./Graft"
import * as Coordinator from "./internal/transition"
import type { OperationIdentity } from "./Plugin"

/** An immutable implementation identity and driver-specific deployment data. */
export interface Candidate {
	readonly driver: string
	readonly identity: string
	readonly deployment: unknown
}

export type Phase =
	| "Admission"
	| "Starting"
	| "Describing"
	| "Serving"
	| "Readiness"
	| "Probing"
	| "Cutover"
	| "Trial"
	| "Draining"
	| "Stopping"
	| "Terminating"
	| "Recovery"
	| "Complete"

/** Every lifecycle deadline is finite. Durations are milliseconds. */
export interface Policy {
	readonly startup: number
	readonly probe: number
	readonly trial: number
	readonly drain: number
	readonly stop: number
	readonly terminate: number
	readonly probes: ReadonlyArray<string>
}

export const defaultPolicy: Policy = {
	startup: 30_000,
	probe: 5_000,
	trial: 0,
	drain: 5_000,
	stop: 5_000,
	terminate: 5_000,
	probes: [],
}

export interface Request {
	readonly fork: number
	readonly candidate: Candidate
	readonly policy?: Partial<Policy> | undefined
}

export interface Termination {
	readonly unit: string
	/** The observed exit status, including an abnormal exit. */
	readonly cause?: Cause.Cause<unknown>
}

export interface Evidence {
	readonly attempt: number
	readonly phase: Phase
	readonly cause?: Cause.Cause<unknown>
	readonly termination?: Termination
}

export type Reason =
	| "Busy"
	| "UnsupportedTarget"
	| "InvalidPolicy"
	| "IncompatibleContract"
	| "OverlapRequired"
	| "Failed"
	| "TimedOut"
	| "UnconfirmedTermination"
	| "Stuck"

export interface Result {
	readonly phase: Phase
	readonly evidence: ReadonlyArray<Evidence>
}
export type Outcome =
	| (Result & { readonly _tag: "Accepted" })
	| (Result & { readonly _tag: "Aborted"; readonly reason: Reason })
	| (Result & { readonly _tag: "Recovered"; readonly reason: Reason })
	| (Result & { readonly _tag: "RecoveryFailed"; readonly reason: Reason })
	| (Result & {
			readonly _tag: "Stuck"
			readonly reason: "UnconfirmedTermination"
	  })

export interface Generation {
	readonly generation: number
	readonly attempt: number
	readonly candidate: Candidate
	readonly state: "Starting" | "Serving" | "Draining" | "Terminated" | "Stuck"
}

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

/** Lifecycle primitives only. Exiting is independent of transport or scope closure. */
export interface Unit {
	readonly start: Effect.Effect<void, DriverError, Scope.Scope>
	readonly describe: Effect.Effect<Description, DriverError>
	readonly serve: Effect.Effect<void, DriverError>
	readonly ready: Effect.Effect<Context.Context<never>, DriverError>
	readonly probe: (name: string) => Effect.Effect<void, DriverError>
	readonly stop: Effect.Effect<void, DriverError>
	readonly terminate: Effect.Effect<void, DriverError>
	readonly exited: Effect.Effect<Termination, DriverError>
	readonly failure: Effect.Effect<never, DriverError>
}

/** Allocation is inert: external execution starts only in Unit.start. */
export interface Driver {
	readonly name: string
	readonly allocate: (
		candidate: Candidate,
		attempt: number,
	) => Effect.Effect<Unit, DriverError>
}

/** Selection and admission happen when the returned Effect executes. */
export interface Invoke {
	<I, S, A, E, R>(
		key: Context.Key<I, S>,
		use: (service: S) => Effect.Effect<A, E, R>,
	): Effect.Effect<A, E | Unavailable | DriverError, R>
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
		) => Effect.Effect<A, E | Unavailable | DriverError, R>,
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
	readonly initial: Candidate
	readonly required: ReadonlyArray<OperationIdentity>
	readonly facades: ReadonlyArray<Facade>
	readonly policy?: Partial<Policy> | undefined
}

/** Registers a driver for the current fork, owned by the fork's scope, and starts its first attempt. */
export const registerDriver: (
	driver: Driver,
	registration: Registration,
) => Effect.Effect<void, DriverError | Graft.ServiceConflict, Graft.Graft> = (
	driver,
	registration,
) => Coordinator.register(driver, registration)

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
