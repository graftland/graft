import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Queue,
	Ref,
	Result,
	Sink,
	Stream,
} from "effect"
import { TransportError } from "../src/Errors"
import * as Framing from "../src/internal/runner/Framing"
import * as Multiplex from "../src/internal/runner/Multiplex"

const bytes = (value: string) => new TextEncoder().encode(value)
const text = (value: Uint8Array) => new TextDecoder().decode(value)
const setup = Effect.gen(function* () {
	const ab = yield* Queue.bounded<Uint8Array, TransportError>(2)
	const ba = yield* Queue.bounded<Uint8Array, TransportError>(2)
	const left = yield* Multiplex.make({
		input: Stream.fromQueue(ba),
		output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
	})
	const right = yield* Multiplex.make({
		input: Stream.fromQueue(ab),
		output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ba, bytes)),
	})
	return { left, right, ab, ba }
})

describe("runner framing", () => {
	it.effect("decodes split headers, split payloads and empty frames", () =>
		Effect.gen(function* () {
			const frames: ReadonlyArray<Framing.Frame> = [
				{ channel: 0, payload: bytes("control") },
				{ channel: 1, payload: new Uint8Array([255, 0, 254]) },
				{ channel: 1, payload: new Uint8Array(0) },
			]
			const encoded = yield* Effect.forEach(frames, Framing.encode)
			const parser = Framing.decoder()
			const decoded = yield* Effect.forEach(
				Array.flatMap(encoded, Array.fromIterable),
				(byte) => Effect.fromResult(parser.decode(new Uint8Array([byte]))),
			)
			assert.deepEqual(Array.flatten(decoded), frames)
			yield* parser.finish
		}),
	)
	it.effect(
		"rejects an oversized length before reading its payload and retains the error",
		() =>
			Effect.gen(function* () {
				const header = new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0])
				new DataView(header.buffer).setUint32(4, Framing.maxPayload + 1)
				const parser = Framing.decoder()
				assert.isTrue(Result.isFailure(parser.decode(header)))
				assert.isTrue(Result.isFailure(parser.decode(new Uint8Array([0]))))
				const short = Framing.decoder()
				assert.isTrue(Result.isSuccess(short.decode(header.subarray(0, 7))))
				const partial = yield* Effect.exit(short.finish)
				assert.isTrue(Exit.isFailure(partial))
			}),
	)
	it.effect(
		"keeps session and reverse traffic moving while instance bytes wait for their consumer",
		() =>
			Effect.gen(function* () {
				const { left, right } = yield* setup
				for (const n of Array.range(0, 19))
					yield* left.send(1, bytes(String(n)))
				yield* left.send(0, bytes("dispose"))
				const dispose = yield* right.take(0)
				assert.equal(text(dispose), "dispose")
				yield* right.send(1, bytes("reverse"))
				const reverse = yield* left.take(1)
				assert.equal(text(reverse), "reverse")
				for (const n of Array.range(0, 19)) {
					const value = yield* right.take(1)
					assert.equal(text(value), String(n))
				}
			}).pipe(Effect.scoped),
	)
	it.effect(
		"fails both channels and directions when the byte stream breaks",
		() =>
			Effect.gen(function* () {
				const { left, right, ab, ba } = yield* setup
				const waiting = yield* Effect.forEach(
					[left.take(0), left.take(1), right.take(0), right.take(1)],
					(effect) => Effect.forkScoped(effect),
				)
				const error = TransportError.make({
					cause: Cause.die(new Error("Partition")),
				})
				yield* Queue.fail(ab, error)
				yield* Queue.fail(ba, error)
				for (const fiber of waiting) {
					const exit = yield* Fiber.await(fiber)
					assert.isTrue(Exit.isFailure(exit))
				}
				const failed = yield* Effect.flip(left.await)
				assert.include(Cause.pretty(failed.cause), "Partition")
			}).pipe(Effect.scoped),
	)
	it.effect("writes queued session frames before instance frames", () =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>()
			const entered = yield* Deferred.make<void>()
			const complete = yield* Deferred.make<ReadonlyArray<number>>()
			const written = yield* Ref.make<ReadonlyArray<number>>([])
			const peer = yield* Multiplex.make({
				input: Stream.never,
				output: Sink.forEach((data: Uint8Array) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(entered, undefined)
						yield* Deferred.await(gate)
						const channels = yield* Ref.updateAndGet(
							written,
							Array.append(
								new DataView(data.buffer, data.byteOffset).getUint8(1),
							),
						)
						if (channels.length === 3)
							yield* Deferred.succeed(complete, channels)
					}),
				),
			})
			yield* peer.send(1, bytes("first"))
			yield* Deferred.await(entered)
			yield* peer.send(1, bytes("instance"))
			yield* peer.send(0, bytes("session"))
			yield* Deferred.succeed(gate, undefined)
			const channels = yield* Deferred.await(complete)
			assert.deepEqual(channels, [1, 0, 1])
		}).pipe(Effect.scoped),
	)
})
