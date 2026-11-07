import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Logger,
	MutableList,
	MutableRef,
	Option,
	Queue,
	Ref,
	References,
	Schema,
	Sink,
	Stream,
	String,
} from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import type { RunnerContract } from "../src/Contract"
import { TransportError } from "../src/Errors"
import * as Child from "../src/internal/child"
import { prepare } from "../src/internal/contract"
import { endpoint } from "../src/internal/control"
import * as Host from "../src/internal/host"
import * as Port from "../src/internal/port"
import { Connection } from "../src/internal/runner/Connection"
import { maxPayload } from "../src/internal/runner/Framing"
import * as Multiplex from "../src/internal/runner/Multiplex"
import * as Wire from "../src/internal/runner/Wire"
import { contract, Rejected } from "./fixtures/contract"

const frame = Schema.fromJsonString(
	Schema.Struct({
		message: Schema.Struct({
			_tag: Schema.String,
			values: Schema.optionalKey(Schema.Array(Schema.Unknown)),
		}),
	}),
)
const levels = ["Trace", "Debug", "Info", "Warn", "Error", "Fatal"] as const

describe("batched log forwarding", () => {
	it.effect(
		"bounds encoded log batches by UTF-8 bytes and serializes each record once",
		() =>
			Effect.gen(function* () {
				const group = RpcGroup.make(
					Rpc.make("Logs", { success: Schema.Unknown, stream: true }).annotate(
						Port.Priority,
						"log",
					),
				)
				const text = String.repeat(maxPayload / 4)("é") + '\n"\\'
				const serialized = MutableRef.make(0)
				const values = Array.makeBy(3, (index) => ({
					toJSON() {
						MutableRef.increment(serialized)
						return { index, text }
					},
				}))
				const ab = yield* Queue.unbounded<Uint8Array>()
				const ba = yield* Queue.unbounded<Uint8Array>()
				const sizes = yield* Ref.make<ReadonlyArray<number>>([])
				const received = yield* Ref.make<ReadonlyArray<unknown>>([])
				const chunks = yield* Ref.make<ReadonlyArray<number>>([])
				const started = yield* Deferred.make<void>()
				const ended = yield* Deferred.make<void>()
				const delivered = yield* Deferred.make<void>()
				const firstPart = yield* Deferred.make<void>()
				const acknowledge = yield* Deferred.make<void>()
				const left = yield* Port.make(
					{
						input: Stream.fromQueue(ba),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
					},
					{ session: "café logs", serve: {}, call: { main: group } },
				)
				const right = yield* Port.make(
					{
						input: Stream.fromQueue(ab),
						output: Sink.forEach((bytes: Uint8Array) =>
							Ref.update(sizes, Array.append(bytes.byteLength)).pipe(
								Effect.andThen(Queue.offer(ba, bytes)),
							),
						),
					},
					{ session: "café logs", serve: { main: group }, call: {} },
				)
				const client = left.clientProtocol("main")
				const server = right.serverProtocol("main")
				yield* server
					.run((_id, message) =>
						message._tag === "Request"
							? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
							: Effect.void,
					)
					.pipe(Effect.forkScoped)
				yield* client
					.run(0, (message) =>
						Effect.gen(function* () {
							if (message._tag === "Chunk") {
								const all = yield* Ref.updateAndGet(
									received,
									Array.appendAll(message.values),
								)
								if (all.length === values.length)
									yield* Deferred.succeed(delivered, undefined)
								const lengths = yield* Ref.updateAndGet(
									chunks,
									Array.append(message.values.length),
								)
								if (lengths.length === 1) {
									yield* Deferred.succeed(firstPart, undefined)
									yield* Deferred.await(acknowledge)
								}
								yield* client
									.send(0, { _tag: "Ack", requestId: message.requestId })
									.pipe(Effect.orDie)
							} else if (message._tag === "Exit")
								yield* Deferred.succeed(ended, undefined)
						}),
					)
					.pipe(Effect.forkScoped)
				yield* client.send(0, {
					_tag: "Request",
					id: "logs",
					tag: "Logs",
					payload: {},
					headers: [],
				})
				yield* Deferred.await(started)
				const writing = yield* server
					.send(0, {
						_tag: "Chunk",
						requestId: "logs",
						values: [values[0]!, values[1]!, values[2]!],
					})
					.pipe(Effect.forkScoped)
				yield* Deferred.await(firstPart)
				const beforeAck = yield* Ref.get(sizes)
				const waiting = yield* Effect.sync(
					() => writing.pollUnsafe() === undefined,
				)
				assert.lengthOf(beforeAck, 1)
				assert.isTrue(waiting)
				yield* Deferred.succeed(acknowledge, undefined)
				yield* Fiber.join(writing)
				yield* Deferred.await(delivered)
				yield* server.send(0, {
					_tag: "Exit",
					requestId: "logs",
					exit: { _tag: "Success", value: null },
				})
				yield* Deferred.await(ended)
				const lengths = yield* Ref.get(chunks)
				const payloads = yield* Ref.get(sizes)
				const all = yield* Ref.get(received)
				const decoded = yield* Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({ index: Schema.Int, text: Schema.String }),
					),
				)(all)
				assert.deepEqual(lengths, [1, 1, 1])
				assert.deepEqual(
					Array.map(decoded, (record) => record.index),
					[0, 1, 2],
				)
				assert.isTrue(Array.every(decoded, (record) => record.text === text))
				assert.isTrue(Array.every(payloads, (size) => size <= maxPayload))
				assert.equal(MutableRef.get(serialized), values.length)
			}),
	)

	it.effect("reassembles a large log chunk across bounded runner frames", () =>
		Effect.gen(function* () {
			const group = RpcGroup.make(
				Rpc.make("Logs", { success: Schema.String, stream: true }).annotate(
					Port.Priority,
					"log",
				),
			)
			// One record alone must exceed the frame limit, independent of batching.
			const text = String.repeat(maxPayload)("x")
			const ab = yield* Queue.unbounded<Uint8Array>()
			const ba = yield* Queue.unbounded<Uint8Array>()
			const sizes = yield* Ref.make<ReadonlyArray<number>>([])
			const leftMux = yield* Multiplex.make({
				input: Stream.fromQueue(ba),
				output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
			})
			const rightMux = yield* Multiplex.make({
				input: Stream.fromQueue(ab),
				output: Sink.forEach((bytes: Uint8Array) =>
					Ref.update(
						sizes,
						Array.append(
							new DataView(
								bytes.buffer,
								bytes.byteOffset,
								bytes.byteLength,
							).getUint32(4),
						),
					).pipe(Effect.andThen(Queue.offer(ba, bytes))),
				),
			})
			const left = yield* Port.make(Wire.channel(leftMux, 1), {
				session: "large-logs",
				serve: {},
				call: { main: group },
			})
			const right = yield* Port.make(Wire.channel(rightMux, 1), {
				session: "large-logs",
				serve: { main: group },
				call: {},
			})
			const handlers = yield* group.toHandlers({
				Logs: () => Stream.fromArray([text, text, text]),
			})
			yield* RpcServer.make(group).pipe(
				Effect.provideContext(handlers),
				Effect.provideService(RpcServer.Protocol, right.serverProtocol("main")),
				Effect.forkScoped,
			)
			const client = yield* RpcClient.make(group).pipe(
				Effect.provideService(RpcClient.Protocol, left.clientProtocol("main")),
			)
			const result = yield* Stream.runCollect(client.Logs())
			assert.deepEqual(result, [text, text, text])
			const payloads = yield* Ref.get(sizes)
			assert.isAtLeast(payloads.length, 3)
			assert.isTrue(Array.every(payloads, (size) => size <= maxPayload))
			assert.equal(payloads[0], maxPayload)
			const dataJson = yield* Schema.encodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						priority: Schema.Literal("data"),
						value: Schema.String,
					}),
				),
			)({ priority: "data", value: text + text })
			const oversizedData = new TextEncoder().encode(dataJson)
			const rejected = yield* Effect.exit(
				Stream.succeed(oversizedData).pipe(
					Stream.run(Wire.channel(leftMux, 1).output),
				),
			)
			assert.isTrue(Exit.isFailure(rejected))
			if (Exit.isFailure(rejected))
				assert.include(
					Cause.pretty(rejected.cause),
					"Runner frame exceeds the payload limit",
				)
		}),
	)

	it.effect(
		"preserves order, levels, annotations and causes, with exact loss warnings and bounded RPC chunks",
		() =>
			Effect.gen(function* () {
				const descriptor: RunnerContract = contract
				const prepared = prepare(descriptor)
				const telemetry = yield* Child.telemetry(prepared)
				// No reader: exactly the first queue-capacity records are admitted.
				yield* Effect.forEach(
					Array.range(0, 299),
					(index) =>
						Effect.logWithLevel(levels[index % levels.length]!)(
							"batched record",
							index,
							index % 2 === 0
								? Cause.empty
								: Cause.fail(Rejected.make({ value: index })),
						).pipe(Effect.annotateLogs({ index })),
					{ discard: true },
				).pipe(
					Effect.provideService(
						Logger.CurrentLoggers,
						new Set([telemetry.logger]),
					),
					Effect.provideService(References.MinimumLogLevel, "Trace"),
				)
				yield* Queue.end(telemetry.logs)
				const ab = yield* Queue.unbounded<Uint8Array>()
				const ba = yield* Queue.unbounded<Uint8Array>()
				const chunks = yield* Ref.make<ReadonlyArray<number>>([])
				const left = yield* Port.make(
					{
						input: Stream.fromQueue(ba),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
					},
					{
						session: "logs",
						serve: {},
						call: { [endpoint]: prepared.control },
					},
				)
				const right = yield* Port.make(
					{
						input: Stream.fromQueue(ab),
						output: Sink.forEach((bytes: Uint8Array) =>
							Schema.decodeEffect(frame)(new TextDecoder().decode(bytes)).pipe(
								Effect.tap(({ message }) =>
									message.values === undefined
										? Effect.void
										: Ref.update(chunks, Array.append(message.values.length)),
								),
								Effect.andThen(Queue.offer(ba, bytes)),
								Effect.mapError((cause) =>
									TransportError.make({ cause: Cause.fail(cause) }),
								),
							),
						),
					},
					{
						session: "logs",
						serve: { [endpoint]: prepared.control },
						call: {},
					},
				)
				const handlers = yield* prepared.control.toHandlers({
					Load: () => Effect.void,
					Dispose: () => Effect.void,
					Events: () => Stream.never,
					Logs: () => telemetry.logStream,
				})
				yield* RpcServer.make(prepared.control).pipe(
					Effect.provideContext(handlers),
					Effect.provideService(
						RpcServer.Protocol,
						right.serverProtocol(endpoint),
					),
					Effect.forkScoped,
				)
				const output = MutableList.make<{
					readonly level: string
					readonly message: unknown
					readonly annotations: Readonly<Record<string, unknown>>
					readonly cause: Cause.Cause<unknown>
				}>()
				const logger = Logger.make((entry) =>
					MutableList.append(output, {
						level: entry.logLevel,
						message: entry.message,
						annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
						cause: entry.cause,
					}),
				)
				const scope = yield* Effect.scope
				const active = yield* Host.initialize(prepared).pipe(
					Effect.provideService(Connection, {
						resources: scope,
						pid: Option.none(),
						diagnostics: Effect.succeed(Cause.empty),
						terminate: () => Effect.void,
						transport: {
							...left,
							failure: left.await,
							report: (cause) => left.fail(TransportError.make({ cause })),
						},
					}),
					Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
					Effect.provideService(References.MinimumLogLevel, "Trace"),
				)
				yield* Deferred.await(active.logsEnded)
				const all = MutableList.toArray(output)
				const logs = Array.filter(
					all,
					(entry) =>
						Array.isArray(entry.message) &&
						entry.message[0] === "batched record",
				)
				const warnings = Array.filter(
					all,
					(entry) =>
						Array.isArray(entry.message) &&
						entry.message[0] === "Remote logs were dropped",
				)
				assert.lengthOf(logs, 128)
				assert.lengthOf(warnings, 1)
				const dropped = Number(warnings[0]!.annotations["remote.logs.dropped"])
				assert.equal(dropped, 172)
				assert.equal(
					warnings[0]!.annotations["remote.logs.droppedTotal"],
					dropped,
				)
				assert.equal(logs.length + dropped, 300)
				for (const [index, log] of logs.entries()) {
					assert.deepEqual(log.message, ["batched record", index])
					assert.equal(log.level, levels[index % levels.length])
					assert.deepEqual(log.annotations["remote.annotations"], { index })
					assert.deepEqual(
						log.cause,
						index % 2 === 0
							? Cause.empty
							: Cause.fail(Rejected.make({ value: index })),
					)
				}
				const sizes = yield* Ref.get(chunks)
				assert.deepEqual(sizes, [128, 1])
				const invalid = yield* Effect.exit(
					prepared.decodeCause([{ _tag: "InvalidReason" }]),
				)
				assert.isTrue(Exit.isFailure(invalid))
			}).pipe(Effect.provide(Graft.layer)),
	)
})
