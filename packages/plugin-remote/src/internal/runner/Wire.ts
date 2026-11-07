import {
	Array,
	Cause,
	Effect,
	Option,
	Result,
	Schema,
	Sink,
	Stream,
} from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { TransportError } from "../../Errors"
import * as Port from "../port"
import { maxPayload } from "./Framing"
import {
	CodeIdentity,
	ExecutionError,
	ExitStatus,
	Handle,
	LeaseExpired,
	Limits,
	PackageError,
	PositiveFinite,
	PositiveInt,
	RunnerClosing,
	SessionAccessDenied,
	SessionConflict,
	SessionRecord,
	SessionStopped,
	StaleSession,
	StateDirectoryLocked,
	StateStorageError,
	Termination,
	TerminationUnconfirmed,
} from "./model"
import type * as Multiplex from "./Multiplex"

/** The RPC boundary is the only place that assembles the runner's error schema. */
export const SessionError = Schema.Union([
	SessionAccessDenied,
	StaleSession,
	LeaseExpired,
	SessionStopped,
	SessionConflict,
	StateStorageError,
	ExecutionError,
	PackageError,
	TerminationUnconfirmed,
	RunnerClosing,
	StateDirectoryLocked,
])
export type SessionError = typeof SessionError.Type

export const Session = RpcGroup.make(
	Rpc.make("HighWater", {
		payload: { instance: Schema.NonEmptyString },
		success: Schema.NullOr(PositiveInt),
		error: SessionError,
	}),
	Rpc.make("Open", {
		payload: {
			instance: Schema.NonEmptyString,
			requestId: Schema.NonEmptyString,
			expectedGeneration: Schema.NullOr(PositiveInt),
			leaseMillis: Schema.optionalKey(PositiveFinite),
			limits: Limits,
		},
		success: SessionRecord,
		error: SessionError,
	}),
	Rpc.make("Load", {
		payload: {
			handle: Handle,
			contract: Schema.NonEmptyString,
			implementation: Schema.NonEmptyString,
			digest: Schema.optionalKey(Schema.Boolean),
		},
		success: CodeIdentity,
		error: SessionError,
	}),
	Rpc.make("Renew", {
		payload: Handle,
		success: Schema.Finite,
		error: SessionError,
	}),
	Rpc.make("Dispose", {
		payload: Handle,
		success: Termination,
		error: SessionError,
	}),
	// Called only when Open advertises terminationNotice. One retained reply avoids polling and subscription races.
	Rpc.make("Terminated", {
		payload: Handle,
		success: ExitStatus,
		error: SessionError,
	}),
	Rpc.make("Status", {
		payload: Handle,
		success: SessionRecord,
		error: SessionError,
	}),
).annotateRpcs(Port.Priority, "control")

// Ordinary messages take the direct path. Only an oversized log chunk needs
// this extra decode to distinguish fragmentation from the existing data-frame rejection.
const logFrame = Schema.decodeUnknownResult(
	Schema.fromJsonString(Schema.Struct({ priority: Schema.Literal("log") })),
)
const decoder = new TextDecoder()
export type Peer = Multiplex.Peer
const send = (peer: Peer, id: 0 | 1, bytes: Uint8Array) =>
	(bytes.length > maxPayload &&
	Result.isSuccess(logFrame(decoder.decode(bytes)))
		? Effect.forEach(
				Array.unfold(0, (offset) =>
					offset < bytes.length
						? Option.some([
								bytes.subarray(offset, offset + maxPayload),
								offset + maxPayload,
							] as const)
						: Option.none(),
				),
				(fragment) => peer.send(id, fragment),
				{ discard: true },
			)
		: peer.send(id, bytes)
	).pipe(
		Effect.mapError((error) =>
			TransportError.make({ cause: Cause.fail(error) }),
		),
	)
/** Preserve the port writer order within each byte channel. */
export const channel = (peer: Peer, id: 0 | 1): Port.Channel => ({
	input: Stream.fromEffectRepeat(peer.take(id)),
	output: Sink.forEach((bytes: Uint8Array) => send(peer, id, bytes)),
})
