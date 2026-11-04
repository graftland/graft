import { Array, Effect, MutableRef, Option, Result, Schema } from "effect"

export class FrameError extends Schema.TaggedError<
	FrameError,
	{ readonly brand: unique symbol }
>()("FrameError", { detail: Schema.String }) {
	override get message() {
		return this.detail
	}
}
export type Channel = 0 | 1
export interface Frame {
	readonly channel: Channel
	readonly payload: Uint8Array
}
export const headerSize = 8
export const maxPayload = 1024 * 1024
const invalid = (detail: string) => FrameError.make({ detail })

/** Version 2 carries only channel and length; request admission belongs to port. */
export const encode = (frame: Frame) =>
	Effect.gen(function* () {
		if (frame.payload.byteLength > maxPayload)
			return yield* invalid("Runner frame exceeds the payload limit")
		const bytes = new Uint8Array(headerSize + frame.payload.byteLength)
		bytes.set([2, frame.channel, 0, 0])
		new DataView(bytes.buffer).setUint32(4, frame.payload.byteLength)
		bytes.set(frame.payload, headerSize)
		return bytes
	})

/** Check a message boundary; the decoder still validates the frame's contents. */
export const isCompleteFrame = (bytes: Uint8Array): boolean =>
	bytes.byteLength >= headerSize &&
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
		4,
	) ===
		bytes.byteLength - headerSize

/** The decoder owns its byte buffer. Results expose malformed frames without throwing through a generator. */
export const decoder = () => {
	const pending = MutableRef.make<Result.Result<Uint8Array, FrameError>>(
		Result.succeed(new Uint8Array(0)),
	)
	const decode = (
		chunk: Uint8Array,
	): Result.Result<ReadonlyArray<Frame>, FrameError> =>
		Result.flatMap(MutableRef.get(pending), (previous) => {
			const bytes = new Uint8Array(previous.length + chunk.length)
			bytes.set(previous)
			bytes.set(chunk, previous.length)
			const frames = Array.unfold(
				0,
				(
					offset,
				): Option.Option<
					readonly [Result.Result<Frame, FrameError>, number]
				> => {
					if (bytes.length - offset < headerSize) return Option.none()
					const header = new DataView(bytes.buffer, offset, headerSize)
					const channel = header.getUint8(1)
					const length = header.getUint32(4)
					if (
						header.getUint8(0) !== 2 ||
						(channel !== 0 && channel !== 1) ||
						header.getUint16(2) !== 0 ||
						length > maxPayload
					)
						return Option.some([
							Result.fail(
								invalid("Invalid runner frame header or payload length"),
							),
							bytes.length,
						])
					const end = offset + headerSize + length
					if (end > bytes.length) return Option.none()
					return Option.some([
						Result.succeed({
							channel,
							payload: bytes.subarray(offset + headerSize, end),
						}),
						end,
					])
				},
			)
			const result = Result.all(frames)
			MutableRef.set(
				pending,
				Result.map(result, (frames) =>
					bytes.subarray(
						Array.reduce(
							frames,
							0,
							(used, frame) => used + headerSize + frame.payload.length,
						),
					),
				),
			)
			return result
		})
	return {
		decode,
		finish: Effect.suspend(() =>
			Effect.fromResult(
				Result.flatMap(MutableRef.get(pending), (bytes) =>
					bytes.length === 0
						? Result.succeed(undefined)
						: Result.fail(invalid("Runner connection ended inside a frame")),
				),
			),
		),
	}
}
