import { Cause, Effect, Sink, Stream } from "effect"
import type { Socket } from "effect/socket"
import { TransportError } from "../Errors"
import { FrameError, isCompleteFrame } from "./runner/Framing"

/** Preserve the socket close reason for connection-level logging. */
export const fromSocket = Effect.fnUntraced(function* (socket: Socket.Socket) {
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	return {
		input: Stream.fromEffectRepeat(reader.pull).pipe(
			Stream.flattenIterable,
			Stream.mapEffect((bytes) => {
				if (typeof bytes === "string")
					return Effect.fail(
						FrameError.make({
							detail: "Runner WebSocket messages must be binary",
						}),
					)
				// WebSocket messages preserve one complete framing frame, including its header.
				if (!isCompleteFrame(bytes))
					return Effect.fail(
						FrameError.make({
							detail: "Invalid runner frame header or payload length",
						}),
					)
				return Effect.succeed(bytes)
			}),
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
