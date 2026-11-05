import { Cause, Effect, FiberSet, Queue, Sink, Stream } from "effect"

import { TransportError } from "../Errors"
import type { Channel } from "./port"

/** Both ends send owned ArrayBuffers; null is the byte stream's EOF. */
export interface Endpoint {
	readonly postMessage: (
		value: ArrayBuffer | null,
		transferList: ArrayBuffer[],
	) => void
	readonly on: (
		event: "message",
		listener: (value: ArrayBuffer | null) => void,
	) => unknown
	readonly off: (
		event: "message",
		listener: (value: ArrayBuffer | null) => void,
	) => unknown
}
export const make = Effect.fnUntraced(function* (endpoint: Endpoint) {
	// Port owns admission and RPC chunk backpressure; this queue only bridges message events.
	const input = yield* Queue.unbounded<Uint8Array, Cause.Done>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const receive = (value: ArrayBuffer | null) =>
		run(
			value === null
				? Queue.end(input)
				: Queue.offer(input, new Uint8Array(value)),
		)
	yield* Effect.acquireRelease(
		Effect.sync(() => endpoint.on("message", receive)),
		() =>
			Effect.sync(() => endpoint.off("message", receive)).pipe(
				Effect.andThen(Queue.shutdown(input)),
			),
	)
	const send = (bytes: Uint8Array | null) =>
		Effect.try({
			try: () => {
				// Copy even Buffer slices: only this fresh, exact-sized backing store is transferable.
				const buffer = bytes === null ? null : new Uint8Array(bytes).buffer
				endpoint.postMessage(buffer, buffer === null ? [] : [buffer])
			},
			catch: (cause) => TransportError.make({ cause: Cause.die(cause) }),
		})
	return {
		input: Stream.fromQueue(input),
		output: Sink.forEach((bytes: Uint8Array) => send(bytes)).pipe(
			// Closing the output half always sends EOF, including when its writer is interrupted.
			Sink.ensuring(send(null)),
		),
	} satisfies Channel
})
