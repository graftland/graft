import { Limits, PositiveInt } from "../Limits"
export { Limits, PositiveInt, PositiveFinite, defaults } from "../Limits"
import {
	Array,
	Cause,
	Context,
	Data,
	Duration,
	Effect,
	Option,
	Schema,
} from "effect"
import type { Scope } from "effect"

const diagnosticCause = Schema.Cause(
	Schema.Defect({ includeStack: true }),
	Schema.Defect({ includeStack: true }),
)
export class PackageError extends Schema.TaggedError<
	PackageError,
	{ readonly brand: unique symbol }
>()("PackageError", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export { PeerAuthenticationError } from "../../Errors"
export class SessionAccessDenied extends Schema.TaggedError<
	SessionAccessDenied,
	{ readonly brand: unique symbol }
>()("SessionAccessDenied", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class StaleSession extends Schema.TaggedError<
	StaleSession,
	{ readonly brand: unique symbol }
>()("StaleSession", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class LeaseExpired extends Schema.TaggedError<
	LeaseExpired,
	{ readonly brand: unique symbol }
>()("LeaseExpired", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class SessionStopped extends Schema.TaggedError<
	SessionStopped,
	{ readonly brand: unique symbol }
>()("SessionStopped", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class SessionConflict extends Schema.TaggedError<
	SessionConflict,
	{ readonly brand: unique symbol }
>()("SessionConflict", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class StateStorageError extends Schema.TaggedError<
	StateStorageError,
	{ readonly brand: unique symbol }
>()("StateStorageError", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class ExecutionError extends Schema.TaggedError<
	ExecutionError,
	{ readonly brand: unique symbol }
>()("ExecutionError", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class TerminationUnconfirmed extends Schema.TaggedError<
	TerminationUnconfirmed,
	{ readonly brand: unique symbol }
>()("TerminationUnconfirmed", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class RunnerClosing extends Schema.TaggedError<
	RunnerClosing,
	{ readonly brand: unique symbol }
>()("RunnerClosing", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export class StateDirectoryLocked extends Schema.TaggedError<
	StateDirectoryLocked,
	{ readonly brand: unique symbol }
>()("StateDirectoryLocked", {
	detail: Schema.String,
	cause: Schema.optionalKey(diagnosticCause),
}) {
	override get message() {
		return this.detail
	}
}
export const Key = Schema.Struct({
	identity: Schema.NonEmptyString,
	instance: Schema.NonEmptyString,
})
export type Key = typeof Key.Type
/** Structural keys keep identity namespaces separate without delimiter conventions. */
export class SessionKey extends Data.Class<Key> {}
export const keyOf = (key: Key) => new SessionKey(key)
export const negotiate = (local: Limits, peer: Limits): Limits => ({
	control: Math.min(local.control, peer.control),
	data: Math.min(local.data, peer.data),
	log: Math.min(local.log, peer.log),
})
export const Handle = Schema.Struct({
	key: Key,
	token: Schema.NonEmptyString,
	generation: PositiveInt,
})
export type Handle = typeof Handle.Type
export const ProcessIdentity = Schema.Struct({
	pid: Schema.Int,
	start: Schema.Struct({ born: Schema.String }),
})
export type ProcessIdentity = typeof ProcessIdentity.Type
export const ExitStatus = Schema.Struct({
	stderr: Schema.optionalKey(Schema.String),
	cause: Schema.optionalKey(diagnosticCause),
	code: Schema.NullOr(Schema.Int),
	signal: Schema.NullOr(Schema.String),
})
export type ExitStatus = typeof ExitStatus.Type
export const CodeIdentity = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	digest: Schema.optionalKey(Schema.String),
})
export type CodeIdentity = typeof CodeIdentity.Type
export const Load = Schema.Struct({
	specifier: Schema.String,
	digest: Schema.optionalKey(Schema.Boolean),
})
export type Load = typeof Load.Type
export const Termination = Schema.Struct({
	kind: Schema.Literals(["Exited", "Killed"]),
	exit: ExitStatus,
	cause: diagnosticCause,
})
export type Termination = typeof Termination.Type
const Fields = {
	version: Schema.Literal(1),
	handle: Handle,
	requestId: Schema.String,
	leaseMillis: Schema.Finite,
	limits: Limits,
}
export const OpenRecord = Schema.Struct({
	...Fields,
	phase: Schema.Literal("Open"),
})
export const Launch = Schema.Union([
	Schema.TaggedStruct("Starting", {}),
	Schema.TaggedStruct("Registered", { child: ProcessIdentity }),
])
export const LoadingRecord = Schema.Struct({
	...Fields,
	phase: Schema.Literal("Loading"),
	load: Load,
	launch: Launch,
})
export const LoadedRecord = Schema.Struct({
	...Fields,
	phase: Schema.Literal("Loaded"),
	load: Load,
	child: ProcessIdentity,
	code: CodeIdentity,
})
export const ActiveRecord = Schema.Union([
	OpenRecord,
	LoadingRecord,
	LoadedRecord,
])
export type ActiveRecord = typeof ActiveRecord.Type
export const StopReason = Schema.Union([
	...Array.map(
		[
			"Disposed",
			"Expired",
			"Superseded",
			"Recovery",
			"Shutdown",
			"Exited",
		] as const,
		(tag) => Schema.TaggedStruct(tag, {}),
	),
	Schema.TaggedStruct("LoadFailed", { cause: diagnosticCause }),
])
export type StopReason = typeof StopReason.Type
export const StoppingRecord = Schema.Struct({
	...Fields,
	phase: Schema.Literal("Stopping"),
	previous: ActiveRecord,
	reason: StopReason,
})
export const StoppedRecord = Schema.Struct({
	...Fields,
	phase: Schema.Literal("Stopped"),
	previous: ActiveRecord,
	reason: StopReason,
	termination: Termination,
})
export const SessionRecord = Schema.Union([
	OpenRecord,
	LoadingRecord,
	LoadedRecord,
	StoppingRecord,
	StoppedRecord,
])
export type SessionRecord = typeof SessionRecord.Type
export const childOf = (
	record: SessionRecord,
): Option.Option<ProcessIdentity> => {
	switch (record.phase) {
		case "Open":
			return Option.none()
		case "Loading":
			return record.launch._tag === "Registered"
				? Option.some(record.launch.child)
				: Option.none()
		case "Loaded":
			return Option.some(record.child)
		case "Stopping":
		case "Stopped":
			return childOf(record.previous)
	}
}
export const stoppingRecord = (
	previous: ActiveRecord,
	reason: StopReason,
): typeof StoppingRecord.Type => ({
	version: previous.version,
	handle: previous.handle,
	requestId: previous.requestId,
	leaseMillis: previous.leaseMillis,
	limits: previous.limits,
	phase: "Stopping",
	previous,
	reason,
})
export const stoppedRecord = (
	previous: ActiveRecord,
	reason: StopReason,
	termination: Termination,
): typeof StoppedRecord.Type => ({
	...stoppingRecord(previous, reason),
	phase: "Stopped",
	termination,
})

export class Store extends Context.Service<
	Store,
	{
		readonly list: Effect.Effect<
			ReadonlyArray<SessionRecord>,
			StateStorageError
		>
		readonly save: (
			record: SessionRecord,
		) => Effect.Effect<void, StateStorageError>
	}
>()("@graftland/plugin-remote/internal/runner/model/Store") {}
export type ExecutionFailure =
	ExecutionError | PackageError | TerminationUnconfirmed
export interface Unit {
	readonly code: CodeIdentity
	/** The supervisor persists identity and renews the lease before releasing the child startup gate. */
	readonly start: Effect.Effect<void, ExecutionFailure>
	readonly identity: ProcessIdentity
	readonly exited: Effect.Effect<ExitStatus, ExecutionFailure>
	readonly interrupt: Effect.Effect<void, ExecutionFailure>
	readonly kill: Effect.Effect<void, ExecutionFailure>
	readonly renew: (millis: number) => Effect.Effect<void, ExecutionFailure>
}
export class Execution extends Context.Service<
	Execution,
	{
		readonly spawn: (
			handle: Handle,
			request: Load,
			limits: Limits,
		) => Effect.Effect<Unit, ExecutionFailure, Scope.Scope>
		readonly recover: (
			child: ProcessIdentity,
		) => Effect.Effect<Termination, ExecutionFailure>
	}
>()("@graftland/plugin-remote/internal/runner/model/Execution") {}
export class RemoteTerminationUnconfirmed extends Schema.TaggedError<
	RemoteTerminationUnconfirmed,
	{ readonly brand: unique symbol }
>()("RemoteTerminationUnconfirmed", { handle: Handle }) {}
/** Losing contact never becomes a successful stop merely because a lease duration passed. */
export const awaitTermination = <E, R>(
	handle: Handle,
	confirmation: Effect.Effect<Termination, E, R>,
	leaseMillis: number,
	marginMillis: number,
) =>
	Effect.gen(function* () {
		const [elapsed, result] = yield* Effect.exit(
			Effect.timeoutOption(confirmation, leaseMillis + marginMillis),
		).pipe(Effect.timed)
		if (result._tag === "Success") {
			if (Option.isSome(result.value)) return result.value.value
			return yield* RemoteTerminationUnconfirmed.make({ handle })
		}
		// Confirmation and the disconnected wait share one deadline.
		yield* Effect.sleep(
			Math.max(0, leaseMillis + marginMillis - Duration.toMillis(elapsed)),
		)
		return yield* Effect.failCause(
			Cause.combine(
				result.cause,
				Cause.fail(RemoteTerminationUnconfirmed.make({ handle })),
			),
		)
	})
