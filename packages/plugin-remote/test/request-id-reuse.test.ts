import { Deferred, Effect, Queue, Ref, Schema, Sink, Stream } from "effect"
import { Rpc, RpcGroup, type RpcMessage } from "effect/rpc"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import * as Port from "../src/internal/port"

const group = RpcGroup.make(Rpc.make("Echo", { success: Schema.Int }))
const request = (id: string): RpcMessage.RequestEncoded => ({
	_tag: "Request",
	id,
	tag: "Echo",
	payload: {},
	headers: [],
})
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const response = (id: string) =>
	encode({
		session: "test",
		endpoint: "main",
		direction: "response",
		priority: "control",
		message: {
			_tag: "Exit",
			requestId: id,
			exit: { _tag: "Success", value: 42 },
		},
	}).pipe(Effect.map((json) => new TextEncoder().encode(json + "\n")))

it.effect("a completed request ID may be reused during result delivery", () =>
	Effect.gen(function* () {
		const input = yield* Queue.unbounded<Uint8Array>()
		const output = yield* Queue.unbounded<Uint8Array>()
		const peer = yield* Port.make(
			{
				input: Stream.fromQueue(input),
				output: Sink.forEach((bytes: Uint8Array) => Queue.offer(output, bytes)),
			},
			{
				session: "test",
				call: { main: group },
				serve: {},
				limits: { data: 1 },
			},
		)
		const protocol = peer.clientProtocol("main")
		const first = yield* Deferred.make<void>()
		const delivery = yield* Ref.make(0)
		yield* protocol
			.run(0, (message) =>
				Effect.gen(function* () {
					if (message._tag !== "Exit") return
					const count = yield* Ref.updateAndGet(delivery, (count) => count + 1)
					if (count === 1) {
						yield* protocol.send(0, request("reusable")).pipe(Effect.orDie)
						yield* Deferred.succeed(first, undefined)
					}
				}),
			)
			.pipe(Effect.forkScoped)
		yield* protocol.send(0, request("reusable"))
		yield* Queue.take(output)
		const firstResponse = yield* response("reusable")
		yield* Queue.offer(input, firstResponse)
		yield* Deferred.await(first)
		yield* Effect.yieldNow
		const secondResponse = yield* response("reusable")
		yield* Queue.offer(input, secondResponse)
		yield* TestClock.adjust("1 millis")
		const delivered = yield* Ref.get(delivery)
		assert.equal(delivered, 2)
	}),
)
