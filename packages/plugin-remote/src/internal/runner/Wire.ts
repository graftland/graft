import { Cause, Effect, Schema, Sink, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { TransportError } from "../../Errors"
import * as Port from "../port"
import {
	CodeIdentity,
	ExecutionError,
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
			specifier: Schema.NonEmptyString,
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
	Rpc.make("Status", {
		payload: Handle,
		success: SessionRecord,
		error: SessionError,
	}),
).annotateRpcs(Port.Priority, "control")

export type Peer = Multiplex.Peer
/** Preserve the port writer order within each byte channel. */
export const channel = (peer: Peer, id: 0 | 1): Port.Channel => ({
	input: Stream.fromEffectRepeat(peer.take(id)),
	output: Sink.forEach((bytes: Uint8Array) =>
		peer
			.send(id, bytes)
			.pipe(
				Effect.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			),
	),
})
