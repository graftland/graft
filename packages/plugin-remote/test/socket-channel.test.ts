import { assert, describe, it } from "@effect/vitest"
import { Array, Cause, Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { Socket } from "effect/socket"
import { TransportError } from "../src/Errors"
import * as Channel from "../src/internal/socketChannel"
import * as Framing from "../src/internal/runner/Framing"

const socket = (write: Socket.Writer["write"]) =>
	Socket.make({
		reader: Effect.succeed({ pull: Effect.never, upgrade: () => Effect.void }),
		writer: Effect.succeed({
			write,
			writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
		}),
	})
describe("WebSocket byte-channel mapping", () => {
	it.effect(
		"waits for native write backpressure before pulling another chunk",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const released = yield* Deferred.make<void>()
				const pulled = yield* Deferred.make<void>()
				const channel = yield* Channel.fromSocket(
					socket(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(released)),
						),
					),
				)
				const frame = yield* Framing.encode({
					channel: 0,
					payload: new Uint8Array([42]),
				})
				const writing = yield* Stream.succeed(frame).pipe(
					Stream.concat(
						Stream.fromEffect(
							Deferred.succeed(pulled, undefined).pipe(Effect.as(frame)),
						),
					),
					Stream.run(channel.output),
					Effect.forkScoped,
				)
				yield* Deferred.await(entered)
				const before = yield* Deferred.isDone(pulled)
				assert.isFalse(before)
				yield* Deferred.succeed(released, undefined)
				yield* Fiber.join(writing)
				const after = yield* Deferred.isDone(pulled)
				assert.isTrue(after)
			}).pipe(Effect.scoped),
	)
	it.effect(
		"preserves a native write failure as the TransportError cause",
		() =>
			Effect.gen(function* () {
				const original = Socket.SocketError.make({
					reason: Socket.SocketWriteError.make({
						cause: new Error("write failed"),
					}),
				})
				const channel = yield* Channel.fromSocket(
					socket(() => Effect.fail(original)),
				)
				const frame = yield* Framing.encode({
					channel: 0,
					payload: new Uint8Array([42]),
				})
				const result = yield* Stream.succeed(frame).pipe(
					Stream.run(channel.output),
					Effect.exit,
				)
				assert.equal(result._tag, "Failure")
				if (result._tag === "Failure") {
					assert.include(Cause.pretty(result.cause), "TransportError")
					assert.isTrue(
						Array.some(
							result.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(TransportError)(reason.error) &&
								Array.some(
									reason.error.cause.reasons,
									(inner) => inner._tag === "Fail" && inner.error === original,
								),
						),
					)
				}
			}).pipe(Effect.scoped),
	)
	it.effect("rejects a trailing partial frame when output ends", () =>
		Effect.gen(function* () {
			const channel = yield* Channel.fromSocket(socket(() => Effect.void))
			const frame = yield* Framing.encode({
				channel: 0,
				payload: new Uint8Array([42]),
			})
			const result = yield* Stream.succeed(frame.subarray(0, 4)).pipe(
				Stream.run(channel.output),
				Effect.exit,
			)
			assert.equal(result._tag, "Failure")
			if (result._tag === "Failure")
				assert.include(
					Cause.pretty(result.cause),
					"Runner connection ended inside a frame",
				)
		}).pipe(Effect.scoped),
	)
})
