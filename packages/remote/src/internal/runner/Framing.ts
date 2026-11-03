import { Effect, Schema } from "effect"

export class FrameError extends Schema.TaggedError<
	FrameError,
	{ readonly brand: unique symbol }
>()("FrameError", { detail: Schema.String }) {
	override get message() {
		return this.detail
	}
}

export type Channel = 0 | 1
export type Priority = 0 | 1 | 2
export interface Frame {
	readonly channel: Channel
	readonly priority: Priority
	readonly kind: "Data" | "Credit"
	readonly payload: Uint8Array
}
export const headerSize = 8
export const maxPayload = 1024 * 1024
/** Fixed by wire version 1, independently of the negotiated RPC admission limits. */
export const window = 4

const invalid = (detail: string) => FrameError.make({ detail })

/** Length is checked before allocating payload storage or decoding any RPC value. */
export const encode = (frame: Frame) =>
	Effect.gen(function* () {
		if (frame.payload.byteLength > maxPayload)
			return yield* invalid("Runner frame exceeds the payload limit")
		if (frame.kind === "Credit" && frame.payload.byteLength !== 0)
			return yield* invalid("Credit frames cannot carry a payload")
		const bytes = new Uint8Array(headerSize + frame.payload.byteLength)
		bytes.set([1, frame.channel, frame.priority, frame.kind === "Data" ? 0 : 1])
		new DataView(bytes.buffer).setUint32(4, frame.payload.byteLength)
		bytes.set(frame.payload, headerSize)
		return bytes
	})

/** Mutable byte buffers belong to this one incremental decoder, never shared between readers. */
export const decoder = () => {
	const header = new Uint8Array(headerSize)
	let headerUsed = 0
	let payload: Uint8Array | undefined
	let payloadUsed = 0
	let poisoned: FrameError | undefined
	const decode = function* (bytes: Uint8Array): Generator<Frame> {
		if (poisoned !== undefined) throw poisoned
		let offset = 0
		while (offset < bytes.byteLength) {
			if (payload === undefined) {
				const length = Math.min(
					headerSize - headerUsed,
					bytes.byteLength - offset,
				)
				header.set(bytes.subarray(offset, offset + length), headerUsed)
				headerUsed += length
				offset += length
				if (headerUsed !== headerSize) continue
				const size = new DataView(header.buffer).getUint32(4)
				if (
					header[0] !== 1 ||
					header[1]! > 1 ||
					header[2]! > 2 ||
					header[3]! > 1 ||
					size > maxPayload ||
					(header[3] === 1 && size !== 0)
				) {
					poisoned = invalid("Invalid runner frame header or payload length")
					throw poisoned
				}
				payload = new Uint8Array(size)
			}
			const length = Math.min(
				payload.byteLength - payloadUsed,
				bytes.byteLength - offset,
			)
			payload.set(bytes.subarray(offset, offset + length), payloadUsed)
			payloadUsed += length
			offset += length
			if (payloadUsed !== payload.byteLength) continue
			const frame: Frame = {
				channel: header[1] === 0 ? 0 : 1,
				priority: header[2] === 0 ? 0 : header[2] === 1 ? 1 : 2,
				kind: header[3] === 0 ? "Data" : "Credit",
				payload,
			}
			payload = undefined
			payloadUsed = 0
			headerUsed = 0
			yield frame
		}
	}
	return {
		decode,
		finish: Effect.suspend(() =>
			headerUsed === 0 && payload === undefined
				? Effect.void
				: Effect.fail(invalid("Runner connection ended inside a frame")),
		),
	}
}
