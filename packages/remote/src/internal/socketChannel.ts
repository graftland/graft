import { Cause, Effect, Sink, Stream } from "effect"
import type { Socket } from "effect/socket"
import { TransportError } from "../Errors"

/** Preserve the socket close reason for connection-level logging. */
export const fromSocket = Effect.fnUntraced(function* (socket: Socket.Socket) {
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	return {
		input: Stream.fromEffectRepeat(reader.pull).pipe(
			Stream.flattenIterable,
			Stream.map((bytes) =>
				typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
			),
			Stream.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
		output: Sink.forEach((bytes: Uint8Array) => writer.write(bytes)).pipe(
			Sink.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
	}
})
