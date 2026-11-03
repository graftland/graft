import { Effect, Sink, Stream, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { TransportError } from "../../Errors"
import * as Duplex from "../duplex"
import type * as Multiplex from "./Multiplex"
import {
	CodeIdentity,
	Handle,
	Limits,
	Record,
	SessionError,
	Termination,
} from "./model"

export const Session = RpcGroup.make(
	Rpc.make("HighWater", {
		payload: { instance: Schema.String },
		success: Schema.NullOr(Schema.Int),
		error: SessionError,
	}),
	Rpc.make("Open", {
		payload: {
			instance: Schema.String,
			requestId: Schema.String,
			expectedGeneration: Schema.NullOr(Schema.Int),
			leaseMillis: Schema.optionalKey(Schema.Finite),
			limits: Limits,
		},
		success: Record,
		error: SessionError,
	}),
	Rpc.make("Load", {
		payload: { handle: Handle, specifier: Schema.String },
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
	Rpc.make("Status", { payload: Handle, success: Record, error: SessionError }),
).annotateRpcs(Duplex.Priority, "control")

export type Peer = Effect.Success<ReturnType<typeof Multiplex.make>>
/**
 * Preserve the duplex writer's order, including Request before Interrupt.
 * The session channel has independent credits and takes priority over instance bytes.
 * The bounded outer window adds at most four already-admitted instance frames.
 */
export const channel = (peer: Peer, id: 0 | 1): Duplex.Channel => ({
	input: Stream.fromEffectRepeat(peer.take(id, id === 0 ? 0 : 1)),
	output: Sink.forEach((bytes: Uint8Array) =>
		peer
			.send(id, id === 0 ? 0 : 1, bytes)
			.pipe(
				Effect.catchCause((cause) =>
					Effect.fail(TransportError.make({ cause })),
				),
			),
	),
})
