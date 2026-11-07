import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Queue,
	Schema,
	Sink,
	Stream,
} from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"
import { assert, describe, it } from "@effect/vitest"

import { TransportError } from "../src/Errors"
import { defaults } from "../src/internal/Limits"
import * as Port from "../src/internal/port"

class Rejected extends Schema.TaggedError<
	Rejected,
	{ readonly brand: unique symbol }
>()("Rejected", {
	value: Schema.Int,
}) {}
const group = RpcGroup.make(
	Rpc.make("Echo", {
		payload: { value: Schema.Int },
		success: Schema.Int,
		error: Rejected,
	}),
)

describe("admitted call results", () => {
	it.effect(
		"releases admission on the peer Exit before local result delivery finishes",
		() =>
			Effect.gen(function* () {
				const ab = yield* Queue.unbounded<Uint8Array>()
				const ba = yield* Queue.unbounded<Uint8Array>()
				const entered = yield* Deferred.make<void>()
				const finish = yield* Deferred.make<void>()
				const left = yield* Port.make(
					{
						input: Stream.fromQueue(ba),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
					},
					{
						session: "delivery",
						serve: {},
						call: { main: group },
						limits: { data: 1 },
					},
				)
				const right = yield* Port.make(
					{
						input: Stream.fromQueue(ab),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ba, bytes)),
					},
					{
						session: "delivery",
						serve: { main: group },
						call: {},
						limits: { data: 1 },
					},
				)
				const handlers = yield* group.toHandlers({
					Echo: ({ value }) => Effect.succeed(value),
				})
				yield* RpcServer.make(group).pipe(
					Effect.provideContext(handlers),
					Effect.provideService(
						RpcServer.Protocol,
						right.serverProtocol("main"),
					),
					Effect.forkScoped,
				)
				const protocol = left.clientProtocol("main")
				yield* protocol
					.run(0, (message) =>
						message._tag === "Exit" && message.requestId === "first"
							? Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(finish)),
								)
							: Effect.void,
					)
					.pipe(Effect.forkScoped)
				const request = (id: string) =>
					protocol.send(0, {
						_tag: "Request",
						id,
						tag: "Echo",
						payload: { value: 0 },
						headers: [],
					})
				yield* request("first")
				yield* Deferred.await(entered)
				yield* request("second")
				const blocked = yield* Deferred.isDone(finish)
				assert.isFalse(blocked)
				yield* Deferred.succeed(finish, undefined)
			}),
	)

	it.effect(
		"fails a parked protocol send even without an RPC receive loop",
		() =>
			Effect.gen(function* () {
				const peer = yield* Port.make(
					{ input: Stream.never, output: Sink.drain },
					{ session: "parked", serve: {}, call: { main: group } },
				)
				const protocol = peer.clientProtocol("main")
				const request = (id: string) =>
					protocol.send(0, {
						_tag: "Request",
						id,
						tag: "Echo",
						payload: { value: 0 },
						headers: [],
					})
				yield* Effect.forEach(
					Array.range(0, defaults.data - 1),
					(id) => request(String(id)),
					{ discard: true },
				)
				const scope = yield* Effect.scope
				const waiting = yield* request("waiting").pipe(
					Effect.forkIn(scope, { startImmediately: true }),
				)
				const pending = yield* Effect.sync(
					() => waiting.pollUnsafe() === undefined,
				)
				assert.isTrue(pending)
				const marker = TransportError.make({
					cause: Cause.die("admission disconnect marker"),
				})
				yield* peer.fail(marker)
				const result = yield* Fiber.await(waiting)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
					assert.equal(error.reason._tag, "RpcClientDefect")
					if (error.reason._tag === "RpcClientDefect")
						assert.deepEqual(error.reason.cause, Cause.fail(marker))
				}
			}),
	)

	it.effect(
		"keeps every result and declared failure while 256 callers share 16 permits",
		() =>
			Effect.gen(function* () {
				const ab = yield* Queue.unbounded<Uint8Array>()
				const ba = yield* Queue.unbounded<Uint8Array>()
				const left = yield* Port.make(
					{
						input: Stream.fromQueue(ba),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
					},
					{ session: "results", serve: {}, call: { main: group } },
				)
				const right = yield* Port.make(
					{
						input: Stream.fromQueue(ab),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ba, bytes)),
					},
					{ session: "results", serve: { main: group }, call: {} },
				)
				const handlers = yield* group.toHandlers({
					Echo: ({ value }) =>
						value % 2 === 0
							? Effect.succeed(value)
							: Effect.fail(Rejected.make({ value })),
				})
				yield* RpcServer.make(group).pipe(
					Effect.provideContext(handlers),
					Effect.provideService(
						RpcServer.Protocol,
						right.serverProtocol("main"),
					),
					Effect.forkScoped,
				)
				const client = yield* RpcClient.make(group).pipe(
					Effect.provideService(
						RpcClient.Protocol,
						left.clientProtocol("main"),
					),
				)
				const results = yield* Effect.forEach(
					Array.range(0, 255),
					(value) => Effect.exit(client.Echo({ value })),
					{ concurrency: 256 },
				)
				for (const [value, result] of results.entries()) {
					if (value % 2 === 0) assert.deepEqual(result, Exit.succeed(value))
					else {
						assert.equal(result._tag, "Failure")
						if (result._tag === "Failure")
							assert.deepEqual(
								result.cause,
								Cause.fail(Rejected.make({ value })),
							)
					}
				}
			}),
	)
})
