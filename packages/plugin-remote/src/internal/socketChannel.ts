import { Cause, Effect, Exit, Sink, Stream } from "effect"
import { Socket } from "effect/socket"
import { TransportError } from "../Errors"
import { FrameError, isCompleteFrame, decoder, encode } from "./runner/Framing"

/** WebSocket boundaries are a wire compatibility detail, not Channel chunk boundaries. */
export const fromSocket = Effect.fnUntraced(function* (socket: Socket.Socket) {
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	return {
		input: Stream.fromEffectRepeat(reader.pull).pipe(
			Stream.catchTag("SocketError", (error) =>
				error.reason._tag === "SocketCloseError" && error.reason.code === 1000
					? Stream.empty
					: Stream.fail(error),
			),
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
		output: Sink.suspend(() => {
			const frames = decoder()
			return Sink.forEach((bytes: Uint8Array) =>
				Effect.fromResult(frames.decode(bytes)).pipe(
					Effect.flatMap((values) =>
						Effect.forEach(
							values,
							(frame) => encode(frame).pipe(Effect.flatMap(writer.write)),
							{ discard: true },
						),
					),
				),
			).pipe(
				Sink.onExit((exit) =>
					Exit.isSuccess(exit)
						? frames.finish.pipe(
								Effect.andThen(writer.write(new Socket.CloseEvent(1000))),
							)
						: Effect.void,
				),
				Sink.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			)
		}),
	}
})
