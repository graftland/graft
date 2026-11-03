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
	it.effect(
		"decodes split headers, split payloads, and empty frames without parsing payload values",
		() =>
			Effect.gen(function* () {
				const frames: ReadonlyArray<Framing.Frame> = [
					{ channel: 0, priority: 0, kind: "Data", payload: bytes("control") },
					{
						channel: 1,
						priority: 2,
						kind: "Data",
						payload: new Uint8Array([255, 0, 254]),
					},
					{
						channel: 1,
						priority: 2,
						kind: "Credit",
						payload: new Uint8Array(0),
					},
				]
				const encoded = yield* Effect.forEach(frames, Framing.encode)
				const parser = Framing.decoder()
				const decoded = Array.flatMap(encoded, (buffer) =>
					Array.flatMap(Array.fromIterable(buffer), (byte) =>
						Array.fromIterable(parser.decode(new Uint8Array([byte]))),
					),
				)
				assert.deepEqual(decoded, frames)
				yield* parser.finish
			}),
	)
	it.effect("rejects an oversized length with only the header present", () =>
		Effect.gen(function* () {
			const header = new Uint8Array([1, 1, 2, 0, 0, 0, 0, 0])
			new DataView(header.buffer).setUint32(4, Framing.maxPayload + 1)
			const parser = Framing.decoder()
			assert.throws(() => Array.fromIterable(parser.decode(header)))
			assert.throws(() =>
				Array.fromIterable(parser.decode(new Uint8Array([0]))),
			)
			const short = Framing.decoder()
			Array.fromIterable(short.decode(header.subarray(0, 7)))
			const partial = yield* Effect.exit(short.finish)
			assert.isTrue(Exit.isFailure(partial))
		}),
	)
	it.effect(
		"backpressures a full log window while control and reverse traffic still progress",
		() =>
			Effect.gen(function* () {
				const { left, right } = yield* setup
				for (const n of Array.range(0, Framing.window - 1))
					yield* left.send(1, 2, bytes(String(n)))
				const fifth = yield* Effect.forkScoped(left.send(1, 2, bytes("last")))
				yield* left.send(0, 0, bytes("dispose"))
				const dispose = yield* right.take(0, 0)
				assert.equal(text(dispose), "dispose")
				yield* right.send(1, 0, bytes("interrupt"))
				const interrupt = yield* left.take(1, 0)
				assert.equal(text(interrupt), "interrupt")
				assert.equal(fifth.pollUnsafe(), undefined)
				for (const n of Array.range(0, Framing.window - 1)) {
					const value = yield* right.take(1, 2)
					assert.equal(text(value), String(n))
				}
				yield* Fiber.join(fifth)
				const last = yield* right.take(1, 2)
				assert.equal(text(last), "last")
			}).pipe(Effect.scoped),
	)
	it.effect(
		"interrupts credit waiters and fails all lanes when the byte channel breaks",
		() =>
			Effect.gen(function* () {
				const { left, right, ab, ba } = yield* setup
				for (const _ of Array.range(1, Framing.window))
					yield* left.send(1, 1, bytes("pending"))
				const canceled = yield* Effect.forkScoped(
					left.send(1, 1, bytes("canceled")),
				)
				yield* Fiber.interrupt(canceled)
				const send = yield* Effect.forkScoped(left.send(1, 1, bytes("blocked")))
				const receive = yield* Effect.forkScoped(
					left.take(0, 0).pipe(Effect.asVoid),
				)
				const reverse = yield* Effect.forkScoped(
					right.take(0, 0).pipe(Effect.asVoid),
				)
				const error = TransportError.make({
					cause: Cause.die(new Error("Partition")),
				})
				yield* Queue.fail(ab, error)
				yield* Queue.fail(ba, error)
				for (const fiber of [send, receive, reverse]) {
					const exit = yield* Fiber.await(fiber)
					assert.isTrue(Exit.isFailure(exit))
				}
				assert.include(
					Cause.pretty((yield* Effect.flip(Deferred.await(left.failed))).cause),
					"Partition",
				)
			}).pipe(Effect.scoped),
	)
	it.effect("disconnects a peer that invents credits", () =>
		Effect.gen(function* () {
			const { ab, right } = yield* setup
			const credit = yield* Framing.encode({
				channel: 1,
				priority: 1,
				kind: "Credit",
				payload: new Uint8Array(0),
			})
			yield* Queue.offer(ab, credit)
			assert.include(
				Cause.pretty((yield* Effect.flip(Deferred.await(right.failed))).cause),
				"unsolicited credit",
			)
		}).pipe(Effect.scoped),
	)
	it.effect(
		"disconnects on inbound overflow instead of blocking control dispatch",
		() =>
			Effect.gen(function* () {
				const { ab, right } = yield* setup
				const frame = yield* Framing.encode({
					channel: 1,
					priority: 2,
					kind: "Data",
					payload: bytes("overflow"),
				})
				for (const _ of Array.range(0, Framing.window))
					yield* Queue.offer(ab, frame)
				assert.include(
					Cause.pretty(
						(yield* Effect.flip(Deferred.await(right.failed))).cause,
					),
					"receive window",
				)
			}).pipe(Effect.scoped),
	)
	it.effect("writes queued control frames before data and logs", () =>
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
						const priorities = yield* Ref.updateAndGet(
							written,
							Array.append(data[2]!),
						)
						if (priorities.length === 6)
							yield* Deferred.succeed(complete, priorities)
					}),
				),
			})
			yield* peer.send(1, 2, bytes("first"))
			yield* Deferred.await(entered)
			yield* peer.send(1, 2, bytes("log"))
			yield* peer.send(1, 2, bytes("log"))
			yield* peer.send(1, 1, bytes("data"))
			yield* peer.send(1, 0, bytes("interrupt"))
			yield* peer.send(0, 0, bytes("renew"))
			yield* Deferred.succeed(gate, undefined)
			const priorities = yield* Deferred.await(complete)
			assert.deepEqual(priorities, [2, 0, 0, 1, 2, 2])
		}).pipe(Effect.scoped),
	)
	it.effect(
		"does not replenish the receive window until credits reach the writer",
		() =>
			Effect.gen(function* () {
				const incoming = yield* Queue.bounded<Uint8Array, TransportError>(2)
				const entered = yield* Deferred.make<void>()
				const peer = yield* Multiplex.make({
					input: Stream.fromQueue(incoming),
					output: Sink.forEach(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					),
				})
				yield* peer.send(0, 0, bytes("block the writer"))
				yield* Deferred.await(entered)
				const frame = yield* Framing.encode({
					channel: 1,
					priority: 2,
					kind: "Data",
					payload: bytes("data"),
				})
				for (const _ of Array.range(1, Framing.window)) {
					yield* Queue.offer(incoming, frame)
					yield* peer.take(1, 2)
				}
				yield* Queue.offer(incoming, frame)
				const failed = yield* Effect.flip(Deferred.await(peer.failed))
				assert.include(Cause.pretty(failed.cause), "receive window")
			}).pipe(Effect.scoped),
	)
})
