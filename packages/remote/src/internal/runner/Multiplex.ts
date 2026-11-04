import {
	Cause,
	Effect,
	Fiber,
	Option,
	Queue,
	Sink,
	Stream,
	TxQueue,
} from "effect"
import type { Socket } from "effect/socket"
import { TransportError } from "../../Errors"
import type { Channel as ByteChannel } from "../port"
import * as FailureGroup from "../FailureGroup"
import * as Framing from "./Framing"

export interface Peer {
	readonly await: Effect.Effect<never, TransportError>
	readonly fail: (error: TransportError) => Effect.Effect<void>
	readonly end: Effect.Effect<void, TransportError>
	readonly send: (
		channel: Framing.Channel,
		payload: Uint8Array,
	) => Effect.Effect<void, TransportError | Framing.FrameError>
	readonly take: (
		channel: Framing.Channel,
	) => Effect.Effect<Uint8Array, TransportError>
}
/** Ports own admission and ACK backpressure. This layer only frames and separates session/instance bytes. */
export const make = Effect.fnUntraced(function* (
	channel: ByteChannel,
): Effect.fn.Return<Peer, never, import("effect").Scope.Scope> {
	const group = yield* FailureGroup.make<TransportError>()
	const incoming = {
		0: yield* Queue.unbounded<Uint8Array>(),
		1: yield* Queue.unbounded<Uint8Array>(),
	}
	const outgoing = {
		0: yield* TxQueue.unbounded<Uint8Array, Cause.Done>(),
		1: yield* TxQueue.unbounded<Uint8Array, Cause.Done>(),
	}
	const next = Effect.tx(
		Effect.gen(function* () {
			const session = yield* TxQueue.poll(outgoing[0])
			if (Option.isSome(session)) return session.value
			const instance = yield* TxQueue.poll(outgoing[1])
			if (Option.isSome(instance)) return instance.value
			if (
				(yield* TxQueue.isDone(outgoing[0])) &&
				(yield* TxQueue.isDone(outgoing[1]))
			)
				return yield* Cause.done()
			return yield* Effect.txRetry
		}),
	)
	const writing = yield* group.run(
		Stream.fromEffectRepeat(next).pipe(
			Stream.run(channel.output),
			Effect.asVoid,
		),
	)
	const decoder = Framing.decoder()
	yield* group.run(
		channel.input.pipe(
			Stream.runForEach((bytes) =>
				Effect.fromResult(decoder.decode(bytes)).pipe(
					Effect.flatMap((frames) =>
						Effect.forEach(
							frames,
							(frame) => Queue.offer(incoming[frame.channel], frame.payload),
							{ discard: true },
						),
					),
				),
			),
			Effect.andThen(decoder.finish),
			Effect.andThen(Effect.fail(Framing.EndOfStream.make({}))),
			Effect.mapError((error) =>
				error._tag === "TransportError"
					? error
					: TransportError.make({ cause: Cause.fail(error) }),
			),
		),
	)
	return {
		await: group.await,
		fail: group.fail,
		end: Effect.tx(
			TxQueue.end(outgoing[0]).pipe(Effect.andThen(TxQueue.end(outgoing[1]))),
		).pipe(Effect.andThen(Fiber.join(writing))),
		send: (id, payload) =>
			group.race(
				Framing.encode({ channel: id, payload }).pipe(
					Effect.flatMap((bytes) => TxQueue.offer(outgoing[id], bytes)),
					Effect.asVoid,
				),
			),
		take: (id) => group.race(Queue.take(incoming[id])),
	}
})
export const fromSocket = Effect.fnUntraced(function* (socket: Socket.Socket) {
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	return yield* make({
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
	})
})
