import { Cause, Effect, Sink, Stream, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { TransportError } from "../../Errors"
import * as Port from "../port"
import type * as Multiplex from "./Multiplex"
import {
	CodeIdentity,
	Handle,
	Limits,
	PositiveInt,
	PositiveFinite,
	SessionRecord,
	InvalidSessionRequest,
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
	Termination,
} from "./model"

/** The RPC boundary is the only place that assembles the runner's error schema. */
export const SessionError = Schema.Union([
	InvalidSessionRequest,
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
		payload: { handle: Handle, specifier: Schema.NonEmptyString },
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
	Rpc.make("Status", {
		payload: Handle,
		success: SessionRecord,
		error: SessionError,
	}),
).annotateRpcs(Port.Priority, "control")

export type Peer = Effect.Success<ReturnType<typeof Multiplex.make>>
/**
 * Preserve the port writer's order, including Request before Interrupt.
 * The session channel has independent credits and takes priority over instance bytes.
 * The bounded outer window adds at most four already-admitted instance frames.
 */
export const channel = (peer: Peer, id: 0 | 1): Port.Channel => ({
	input: Stream.fromEffectRepeat(peer.take(id, id === 0 ? 0 : 1)),
	output: Sink.forEach((bytes: Uint8Array) =>
		peer
			.send(id, id === 0 ? 0 : 1, bytes)
			.pipe(
				Effect.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			),
	),
})
