import { Array, Cause, Effect, Schema } from "effect"
import { Socket } from "effect/socket"
import { TransportError } from "../../Errors"
import { Peer } from "../../Auth"

// Multiplex preserves the socket reason inside TransportError; only an entirely normal close is silent.
const closedNormally = (cause: Cause.Cause<unknown>): boolean =>
	cause.reasons.length > 0 &&
	Array.every(
		cause.reasons,
		(reason) =>
			reason._tag === "Fail" &&
			(Schema.is(TransportError)(reason.error)
				? closedNormally(reason.error.cause)
				: Socket.isSocketError(reason.error) &&
					reason.error.reason._tag === "SocketCloseError" &&
					reason.error.reason.code === 1000),
	)
export const connectionEnded = (cause: Cause.Cause<unknown>) =>
	Cause.hasInterruptsOnly(cause) || closedNormally(cause)
		? Effect.void
		: Effect.flatMap(Peer, (identity) =>
				Effect.logWarning("Remote host connection failed", cause).pipe(
					Effect.annotateLogs({ "remote.peer": identity }),
				),
			)
