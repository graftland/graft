/** Single-fork, stateless transitions and execution-driver extension points. */
import {
	Context,
	Data,
	Effect,
	Option,
	Schema,
	type Cause,
	type Duration,
	type Scope,
} from "effect"

import * as Graft from "./Graft"
import * as Coordinator from "./internal/transition"
import type { OperationIdentity } from "./Plugin"
import type { Unapproved } from "./Trust"

/** An immutable implementation identity and driver-owned immutable deployment snapshot. Custom drivers must detach and validate caller-owned input before registration or admission. */
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

/** Every lifecycle deadline is finite. The total includes cleanup and recovery. */
export interface Policy {
	readonly total: Duration.Input
	readonly startup: Duration.Input
	readonly probe: Duration.Input
	readonly trial: Duration.Input
	readonly drain: Duration.Input
	readonly stop: Duration.Input
	readonly terminate: Duration.Input
	readonly probes: ReadonlyArray<string>
}

export const defaultPolicy: Policy = {
	total: "5 minutes",
	startup: 30_000,
	probe: 5_000,
	trial: 0,
	drain: 5_000,
	stop: 5_000,
	terminate: 5_000,
	probes: [],
}

/** Loader binds this reference to its entry id. Embedded registrations name themselves. */
export const CurrentInstance = Context.Reference<Option.Option<string>>(
	"@graftland/graft/Transition/CurrentInstance",
	{ defaultValue: Option.none },
)

export interface Request {
	/** Managed instance name (Loader entry id), or the owning fork id. */
	readonly target: string | number
	readonly candidate: Candidate
	readonly policy?: Partial<Policy> | undefined
}

export interface Termination {
	readonly unit: string
	/** NotStarted proves startup was prevented or settled without creating an execution. */
	readonly state: "Exited" | "NotStarted"
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
	| "Closing"
	| "CoordinatorDefect"
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
export type Outcome = Data.TaggedEnum<{
	Accepted: Result
	Aborted: Result & { readonly reason: Reason }
	Recovered: Result & { readonly reason: Reason }
	RecoveryFailed: Result & { readonly reason: Reason }
	Stuck: Result & { readonly reason: "UnconfirmedTermination" }
}>
export const Outcome = Data.taggedEnum<Outcome>()

/** Retain at most this many retired summaries per fork. */
export const generationHistoryLimit = 32
export interface CandidateIdentity {
	readonly driver: string
	readonly identity: string
}
export interface Generation {
	readonly generation: number
	readonly attempt: number
	readonly candidate: CandidateIdentity
	readonly state: "Starting" | "Serving" | "Draining" | "Terminated" | "Stuck"
}

/** Live event with the complete candidate; consumers own any historical archive. */
export interface GenerationEvent extends Generation {
	readonly candidate: Candidate
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

/** The attempt is at its admitted-call limit; this call was not admitted. */
export class AdmissionRejected extends Schema.TaggedError<
	AdmissionRejected,
	{ readonly brand: unique symbol }
>()("AdmissionRejected", {
	fork: Schema.Finite,
	attempt: Schema.Finite,
	limit: Schema.Finite,
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

/** Allocation owns resources in the attempt scope, even if startup never runs. External execution starts only in Unit.start. */
export interface Driver {
	readonly name: string
	readonly allocate: (
		candidate: Candidate,
		attempt: number,
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
