import { Cause, Context, Effect, Schema, Record as EffectRecord } from "effect"
import { Option } from "effect"
import type { Scope } from "effect"

export class SessionError extends Schema.TaggedError<
	SessionError,
	{ readonly brand: unique symbol }
>()("SessionError", {
	reason: Schema.Literals([
		"InvalidRequest",
		"Stale",
		"Expired",
		"Stopped",
		"Conflict",
		"Storage",
		"Execution",
		"Unconfirmed",
		"Closing",
	]),
	detail: Schema.String,
	cause: Schema.Cause(
		Schema.Defect({ includeStack: true }),
		Schema.Defect({ includeStack: true }),
	),
}) {
	override get message() {
		return this.detail
	}
}
export const failure = (
	reason: SessionError["reason"],
	detail: string,
	cause: Cause.Cause<unknown> = Cause.empty,
) => SessionError.make({ reason, detail, cause })
export const Key = Schema.Struct({
	identity: Schema.String,
	instance: Schema.String,
})
export type Key = typeof Key.Type
// Length-prefixing prevents namespace collisions without using input as a filesystem path.
export const keyOf = (key: Key) =>
	`${key.identity.length}:${key.identity}${key.instance}`
export const Limits = Schema.Struct({
	control: Schema.Int,
	data: Schema.Int,
	log: Schema.Int,
})
export type Limits = typeof Limits.Type
export const defaults: Limits = { control: 8, data: 16, log: 2 }
export const negotiate = (
	local: Limits,
	peer: Limits,
): Effect.Effect<Limits, SessionError> =>
	Effect.gen(function* () {
		for (const value of [
			...EffectRecord.values(local),
			...EffectRecord.values(peer),
		])
			if (!Number.isSafeInteger(value) || value <= 0)
				return yield* failure(
					"InvalidRequest",
					"RPC limits must be positive safe integers",
				)
		// Both peers, including the child, install these symmetric limits before data RPC.
		return {
			control: Math.min(local.control, peer.control),
			data: Math.min(local.data, peer.data),
			log: Math.min(local.log, peer.log),
		}
	})
export const Handle = Schema.Struct({
	key: Key,
	token: Schema.String,
	generation: Schema.Int,
})
export type Handle = typeof Handle.Type
export const ProcessIdentity = Schema.Struct({
	pid: Schema.Int,
	start: Schema.String,
})
export type ProcessIdentity = typeof ProcessIdentity.Type
export const ExitStatus = Schema.Struct({
	code: Schema.NullOr(Schema.Int),
	signal: Schema.NullOr(Schema.String),
})
export type ExitStatus = typeof ExitStatus.Type
export const CodeIdentity = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	digest: Schema.String,
})
export type CodeIdentity = typeof CodeIdentity.Type
export const Load = Schema.Struct({ specifier: Schema.String })
export type Load = typeof Load.Type
export const Termination = Schema.Struct({
	kind: Schema.Literals(["Exited", "Killed"]),
	exit: ExitStatus,
	cause: Schema.Cause(SessionError, Schema.Defect({ includeStack: true })),
})
export type Termination = typeof Termination.Type
export const Record = Schema.Struct({
	version: Schema.Literal(1),
	handle: Handle,
	requestId: Schema.String,
	leaseMillis: Schema.Finite,
	limits: Limits,
	phase: Schema.Literals(["Open", "Loading", "Loaded", "Stopping", "Stopped"]),
	reason: Schema.optionalKey(
		Schema.Literals([
			"Disposed",
			"Expired",
			"Superseded",
			"Recovery",
			"Shutdown",
			"LoadFailed",
			"Exited",
		]),
	),
	child: Schema.optionalKey(ProcessIdentity),
	load: Schema.optionalKey(Load),
	code: Schema.optionalKey(CodeIdentity),
	loadFailure: Schema.optionalKey(
		Schema.Cause(SessionError, Schema.Defect({ includeStack: true })),
	),
	termination: Schema.optionalKey(Termination),
})
export type Record = typeof Record.Type

/** One exclusive supervisor owns a store; the daemon must lock its state directory. */
export class Store extends Context.Service<
	Store,
	{
		readonly list: Effect.Effect<ReadonlyArray<Record>, SessionError>
		readonly save: (record: Record) => Effect.Effect<void, SessionError>
	}
>()("@graftland/remote/internal/runner/model/Store") {}

export interface Unit {
	readonly identity: ProcessIdentity
	readonly exited: Effect.Effect<ExitStatus, SessionError>
	/** Request graceful shutdown without requiring the peer's business RPC schemas. */
	readonly interrupt: Effect.Effect<void, SessionError>
	readonly kill: Effect.Effect<void, SessionError>
}
/**
 * The adapter starts a gated child bootstrap, registers it before restoring
 * interruption, and does not load plugin code before the session Load reply.
 * Its scope owns the process even if registration or launch fails.
 */
export class Execution extends Context.Service<
	Execution,
	{
		readonly spawn: (
			handle: Handle,
			request: Load,
			register: (unit: Unit) => Effect.Effect<void, SessionError>,
		) => Effect.Effect<CodeIdentity, SessionError, Scope.Scope>
		/** Match both PID and start identity; never signal a reused PID. Confirm exit before returning. */
		readonly recover: (
			child: ProcessIdentity,
		) => Effect.Effect<Termination, SessionError>
	}
>()("@graftland/remote/internal/runner/model/Execution") {}

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
		const result = yield* Effect.exit(
			Effect.timeoutOption(confirmation, leaseMillis + marginMillis),
		)
		if (result._tag === "Success") {
			if (Option.isSome(result.value)) return result.value.value
			return yield* RemoteTerminationUnconfirmed.make({ handle })
		}
		yield* Effect.sleep(leaseMillis + marginMillis)
		return yield* Effect.failCause(
			Cause.combine(
				result.cause,
				Cause.fail(RemoteTerminationUnconfirmed.make({ handle })),
			),
		)
	})
