/** Identifiable runtime changes, admission rejections, and observable member facts. */
import {
	Clock,
	Data,
	Effect,
	HashMap,
	Option,
	Schema,
	Stream,
	TxPubSub,
	TxQueue,
	TxRef,
	type Cause,
	type Duration,
} from "effect"

import type { Graft } from "./Graft"
import * as Coordinator from "./internal/changeCoordinator"
import { RuntimeContext } from "./internal/runtimeContext"

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

export interface Termination {
	readonly unit: string
	/** NotStarted proves startup was prevented or settled without creating an execution. */
	readonly state: "Exited" | "NotStarted"
	/** The observed exit status, including an abnormal exit. */
	readonly cause?: Cause.Cause<unknown>
}

export interface Evidence {
	/** Absent for metadata preparation, before an execution generation exists. */
	readonly attempt?: number | undefined
	readonly phase: Phase
	readonly cause?: Cause.Cause<unknown>
	readonly termination?: Termination
}

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

export const Id = Schema.String.pipe(Schema.brand("@graftland/graft/Change/Id"))
export type Id = typeof Id.Type
export type Strategy = "Overlap" | "Restart"

/** Each limit applies to one operation. Total also includes cleanup and recovery. */
export interface Budget {
	readonly total: Duration.Input
	readonly startup: Duration.Input
	readonly probe: Duration.Input
	readonly drain: Duration.Input
	readonly stop: Duration.Input
	readonly terminate: Duration.Input
}
export interface Requirements {
	readonly probes: ReadonlyArray<string>
	readonly trial: Duration.Input
}
export const defaultBudget: Budget = {
	total: "5 minutes",
	startup: "30 seconds",
	probe: "5 seconds",
	drain: "5 seconds",
	stop: "5 seconds",
	terminate: "5 seconds",
}
export const defaultRequirements: Requirements = { probes: [], trial: 0 }

export interface Request {
	readonly key?: string | undefined
	readonly instance: string
	readonly candidate: Candidate
	readonly strategy?: Strategy | undefined
	readonly expected?: number | undefined
	readonly budget?: Partial<Budget> | undefined
	readonly requirements?: Partial<Requirements> | undefined
}

export const ObjectKey = Schema.TaggedUnion({
	Instance: { instance: Schema.String },
	Slot: { realm: Schema.String, key: Schema.String },
	Edge: { consumer: Schema.String, provider: Schema.String },
})
export type ObjectKey = typeof ObjectKey.Type
export const Conflict = Schema.Struct({
	object: ObjectKey,
	holders: Schema.Array(Id),
})
export type Conflict = typeof Conflict.Type

export const Rejection = Schema.TaggedUnion({
	Busy: { conflicts: Schema.Array(Conflict) },
	Closing: {},
	UnsupportedTarget: { instance: Schema.String },
	InvalidBudget: { message: Schema.String },
	Stale: { object: ObjectKey, expected: Schema.Finite, actual: Schema.Finite },
	KeyConflict: { key: Schema.String },
	Capacity: { maxUnits: Schema.Finite, required: Schema.Finite },
	Unsupported: { message: Schema.String },
})
export type Rejection = typeof Rejection.Type
/** Rejected requests never receive a Change id. */
export class ChangeRejected extends Schema.TaggedError<
	ChangeRejected,
	{ readonly brand: unique symbol }
>()("ChangeRejected", {
	reason: Rejection,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}

export type Health = "Serving" | "Unavailable" | "Stopped" | "Unknown"
export interface Desired {
	readonly candidate: Candidate
	readonly version: number
}
export interface Actual {
	readonly version: number
	readonly generation: number | undefined
	readonly health: Health
	readonly matchesTarget: boolean
}
export type Execution = Data.TaggedEnum<{
	NotStarted: {}
	Running: { readonly phase: Phase }
	Completed: { readonly phase: Phase; readonly outcome: Outcome["_tag"] }
}>
export const Execution = Data.taggedEnum<Execution>()
export interface Member {
	readonly instance: string
	readonly selection: "Requested"
	readonly starting: { readonly version: number; readonly health: Health }
	readonly desired: Desired
	readonly execution: Execution
	readonly compensation: "NotNeeded"
	readonly actual: Actual
	readonly recoverability: {
		readonly possible: boolean
		readonly reason: string
	}
}
export type Reason =
	| "Closing"
	| "CoordinatorDefect"
	| "IncompatibleContract"
	| "Failed"
	| "TimedOut"
	| "Cancelled"
	| "Stale"
	| "UnconfirmedTermination"
	| "UnresolvedCleanup"
export interface Result {
	readonly change: Id
	readonly phase: Phase
	readonly evidence: ReadonlyArray<Evidence>
	readonly members: ReadonlyArray<Member>
}
export type Outcome = Data.TaggedEnum<{
	Accepted: Result
	Aborted: Result & { readonly reason: Reason }
	Recovered: Result & { readonly reason: Reason }
	RecoveryFailed: Result & { readonly reason: Reason }
	Stuck: Result & {
		readonly reason: "UnconfirmedTermination" | "UnresolvedCleanup"
	}
}>
export const Outcome = Data.taggedEnum<Outcome>()
export interface Handle {
	readonly id: Id
	readonly await: Effect.Effect<Outcome>
	readonly cancel: Effect.Effect<void>
}
export interface Settlement {
	readonly generation: number
	readonly execution: "Unconfirmed" | "Exited" | "NotStarted"
	readonly cleanup: "Pending" | "Completed" | "Failed" | "Unknown"
	readonly cause: Cause.Cause<unknown>
}
export interface Status {
	readonly id: Id
	readonly key: string | undefined
	readonly source: "Application"
	readonly sequence: number
	readonly instance: string
	readonly strategy: Strategy
	readonly phase: Phase
	readonly remaining: number
	readonly members: ReadonlyArray<Member>
	readonly leaseHolders: ReadonlyArray<number>
	readonly unconfirmedUnits: ReadonlyArray<number>
	readonly settlement: ReadonlyArray<Settlement>
	readonly preparation?:
		| {
				readonly cleanup: Settlement["cleanup"]
				readonly cause: Cause.Cause<unknown>
		  }
		| undefined
	readonly evidence: ReadonlyArray<Evidence>
	readonly outcome: import("effect").Option.Option<Outcome>
}
export const historyLimit = 128

/** Admits immediately; the runtime owns execution independently of the caller. */
export const submit: (
	request: Request,
) => Effect.Effect<Handle, ChangeRejected, Graft> = Coordinator.submit
/** Runs an admitted Change to its immutable outcome. Cancelling the wait leaves it running. */
export const run = (
	request: Request,
): Effect.Effect<Outcome, ChangeRejected, Graft> =>
	submit(request).pipe(Effect.flatMap((handle) => handle.await))
/** Unknown and evicted Change ids are absent. */
export const get = Effect.fnUntraced(function* (
	id: Id,
): Effect.fn.Return<Option.Option<Status>, never, Graft> {
	const { runtime } = yield* RuntimeContext
	const records = yield* TxRef.get(runtime.changes.records)
	const found = HashMap.get(records, id)
	if (Option.isNone(found)) return Option.none()
	const status = yield* TxRef.get(found.value.status)
	const elapsed =
		Number((yield* Clock.monotonicTimeNanos) - found.value.started) / 1_000_000
	return Option.some({
		...status,
		remaining: Math.max(0, found.value.request.budget.total - elapsed),
	})
})
/** Bounded sliding notifications; use get to reconcile missed sequence numbers. */
export const changes: Stream.Stream<Status, never, Graft> = Stream.unwrap(
	Effect.gen(function* () {
		const { runtime } = yield* RuntimeContext
		const queue = yield* TxPubSub.subscribe(runtime.changes.events)
		return Stream.fromEffectRepeat(TxQueue.take(queue))
	}),
)
