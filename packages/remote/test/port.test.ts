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
	Schedule,
	Schema,
	Sink,
	Stream,
} from "effect"
import { Rpc, RpcClient, RpcGroup, RpcMessage, RpcServer } from "effect/rpc"
import * as Port from "../src/internal/port"
import { TransportError } from "../src/Errors"

const Group = RpcGroup.make(
	Rpc.make("Hold"),
	Rpc.make("Echo", { payload: { value: Schema.Int }, success: Schema.Int }),
	Rpc.make("Ping", { success: Schema.String }).annotate(
		Port.Priority,
		"control",
	),
	Rpc.make("Flood", { success: Schema.Int, stream: true }).annotate(
		Port.Priority,
		"log",
	),
)
const until = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean) =>
	effect.pipe(
		Effect.repeat({ schedule: Schedule.spaced("1 millis"), until: predicate }),
		Effect.timeout("2 seconds"),
	)
const encode = (value: unknown) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
		Effect.map((json) => new TextEncoder().encode(json + "\n")),
	)
const request = (id: string, tag: string): RpcMessage.RequestEncoded => ({
	_tag: "Request",
	id,
	tag,
	payload: {},
	headers: [],
})
const capture = Effect.gen(function* () {
	const gate = yield* Deferred.make<void>()
	const started = yield* Deferred.make<void>()
	const written = yield* Queue.unbounded<{
		readonly priority: string
		readonly message: {
			readonly _tag: string
			readonly id?: string | undefined
		}
	}>()
	const peer = yield* Port.make(
		{
			input: Stream.never,
			output: Sink.forEach((bytes: Uint8Array) =>
				Effect.gen(function* () {
					yield* Deferred.succeed(started, undefined)
					yield* Deferred.await(gate)
					const frame = yield* Schema.decodeEffect(
						Schema.fromJsonString(
							Schema.Struct({
								priority: Schema.String,
								message: Schema.Struct({
									_tag: Schema.String,
									id: Schema.optional(Schema.String),
								}),
							}),
						),
					)(new TextDecoder().decode(bytes))
					yield* Queue.offer(written, frame)
				}).pipe(
					Effect.mapError((cause) =>
						TransportError.make({ cause: Cause.fail(cause) }),
					),
				),
			),
		},
		{
			session: "current",
			serve: {},
			call: { main: Group },
			limits: { log: 8 },
		},
	)
	const send = (id: string, tag: string) =>
		peer.clientProtocol("main").send(0, request(id, tag))
	return { peer, send, gate, started, written }
})
const setup = Effect.gen(function* () {
	const ab = yield* Queue.bounded<Uint8Array, TransportError | Cause.Done>(4)
	const ba = yield* Queue.bounded<Uint8Array, TransportError | Cause.Done>(4)
	const left = yield* Port.make(
		{
			input: Stream.fromQueue(ba),
			output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
		},
		{
			session: "current",
			serve: { main: Group },
			call: { main: Group },
			limits: { data: 2 },
		},
	)
	const right = yield* Port.make(
		{
			input: Stream.fromQueue(ab),
			output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ba, bytes)),
		},
		{
			session: "current",
			serve: { main: Group },
			call: { main: Group },
			limits: { data: 2 },
		},
	)
	const started = yield* Queue.unbounded<void>()
	const closed = yield* Ref.make(0)
	const bindings = yield* Group.toHandlers({
		Hold: () =>
			Queue.offer(started, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Ref.update(closed, (n) => n + 1)),
			),
		Echo: ({ value }) => Effect.succeed(value),
		Ping: () => Effect.succeed("pong"),
		Flood: () => Stream.iterate(0, (n) => n + 1),
	})
	for (const peer of [left, right]) {
		yield* RpcServer.make(Group, { disableFatalDefects: true }).pipe(
			Effect.provideContext(bindings),
			Effect.provideService(RpcServer.Protocol, peer.serverProtocol("main")),
			Effect.forkScoped,
		)
	}
	const a = yield* RpcClient.make(Group).pipe(
		Effect.provideService(RpcClient.Protocol, left.clientProtocol("main")),
	)
	const b = yield* RpcClient.make(Group).pipe(
		Effect.provideService(RpcClient.Protocol, right.clientProtocol("main")),
	)
	return { a, b, left, right, ab, ba, closed, started }
})
describe("endpoint port", () => {
	it.live(
		"bounds admitted calls and keeps control usable with saturated data and backpressured logs",
		() =>
			Effect.gen(function* () {
				const { a, left, right } = yield* setup
				const first = yield* Effect.forkScoped(a.Hold())
				const second = yield* Effect.forkScoped(a.Hold())
				yield* until(right.diagnostics, (s) => s.incoming === 2)
				const calls = yield* Effect.forEach(
					Array.range(0, 99),
					(value) => a.Echo({ value }),
					{ concurrency: "unbounded" },
				).pipe(Effect.forkScoped)
				yield* Effect.yieldNow
				assert.equal(calls.pollUnsafe(), undefined)
				const received = yield* Deferred.make<void>()
				yield* a.Flood().pipe(
					Stream.runForEach(() =>
						Deferred.succeed(received, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					),
					Effect.forkScoped,
				)
				yield* Deferred.await(received)
				const pong = yield* a.Ping().pipe(Effect.timeout("1 second"))
				assert.equal(pong, "pong")
				yield* Fiber.interrupt(first)
				yield* Fiber.interrupt(second)
				yield* until(left.diagnostics, (s) => s.outgoing === 1)
				const values = yield* Fiber.join(calls).pipe(
					Effect.timeout("2 seconds"),
				)
				assert.deepEqual(values, Array.range(0, 99))
				const stats = yield* left.diagnostics
				assert.isAtMost(stats.highWaterOutgoing, 4)
			}).pipe(Effect.scoped),
	)
	it.live(
		"backpressures 100 concurrent calls without exceeding two in-flight requests",
		() =>
			Effect.gen(function* () {
				const { a, left, right } = yield* setup
				const values = yield* Effect.forEach(
					Array.range(0, 99),
					(value) => a.Echo({ value }),
					{ concurrency: "unbounded" },
				)
				assert.deepEqual(values, Array.range(0, 99))
				const outgoing = yield* left.diagnostics
				const incoming = yield* right.diagnostics
				assert.isAtMost(outgoing.highWaterOutgoing, 2)
				assert.isAtMost(incoming.highWaterIncoming, 2)
			}).pipe(Effect.scoped),
	)
	it.live(
		"interrupts an admission waiter without leaking a slot and fails waiters on disconnect",
		() =>
			Effect.gen(function* () {
				const { a, right, ba } = yield* setup
				const first = yield* Effect.forkScoped(a.Hold())
				yield* Effect.forkScoped(a.Hold())
				yield* until(right.diagnostics, (s) => s.incoming === 2)
				const canceled = yield* Effect.forkScoped(a.Echo({ value: 1 }))
				yield* Effect.yieldNow
				assert.equal(canceled.pollUnsafe(), undefined)
				yield* Fiber.interrupt(canceled).pipe(Effect.timeout("1 second"))
				const canceledExit = yield* Fiber.await(canceled)
				assert.isTrue(
					Exit.isFailure(canceledExit) &&
						Cause.hasInterruptsOnly(canceledExit.cause),
				)
				yield* Fiber.interrupt(first)
				const value = yield* a
					.Echo({ value: 2 })
					.pipe(Effect.timeout("1 second"))
				assert.equal(value, 2)
				yield* Effect.forkScoped(a.Hold())
				yield* until(right.diagnostics, (s) => s.incoming === 2)
				const waiting = yield* Effect.forkScoped(a.Echo({ value: 3 }))
				yield* Effect.yieldNow
				assert.equal(waiting.pollUnsafe(), undefined)
				yield* Queue.fail(
					ba,
					TransportError.make({ cause: Cause.die(new Error("Disconnected")) }),
				)
				const failed = yield* Fiber.await(waiting).pipe(
					Effect.timeout("1 second"),
				)
				assert.isTrue(Exit.isFailure(failed) && Cause.hasFails(failed.cause))
			}).pipe(Effect.scoped),
	)

	it.live("disconnects a peer that exceeds the inbound admission limit", () =>
		Effect.gen(function* () {
			const { a, ab, right } = yield* setup
			yield* Effect.forkScoped(a.Hold())
			yield* Effect.forkScoped(a.Hold())
			yield* until(right.diagnostics, (s) => s.incoming === 2)
			const overflow = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Json),
			)({
				session: "current",
				endpoint: "main",
				direction: "request",
				priority: "data",
				message: {
					_tag: "Request",
					id: "overflow",
					tag: "Hold",
					payload: {},
					headers: [],
				},
			})
			yield* Queue.offer(ab, new TextEncoder().encode(overflow + "\n"))
			const failure = yield* Effect.flip(right.await).pipe(
				Effect.timeout("1 second"),
			)
			assert.include(
				Cause.pretty(failure.cause),
				"RPC admission limit exceeded for data",
			)
			const stats = yield* right.diagnostics
			assert.equal(stats.highWaterIncoming, 2)
		}).pipe(Effect.scoped),
	)

	it.live(
		"fails both RPC directions and interrupts both servers when the byte channel fails",
		() =>
			Effect.gen(function* () {
				const { a, b, ab, ba, closed, started } = yield* setup
				const first = yield* Effect.forkScoped(a.Hold())
				const second = yield* Effect.forkScoped(b.Hold())
				// Admission precedes dispatch: wait until both handlers have installed
				// their finalizers before testing interruption of running requests.
				yield* Queue.take(started).pipe(Effect.timeout("2 seconds"))
				yield* Queue.take(started).pipe(Effect.timeout("2 seconds"))
				const error = TransportError.make({
					cause: Cause.die(new Error("Disconnected")),
				})
				yield* Queue.fail(ab, error)
				yield* Queue.fail(ba, error)
				const firstExit = yield* Fiber.await(first).pipe(
					Effect.timeout("1 second"),
				)
				const secondExit = yield* Fiber.await(second).pipe(
					Effect.timeout("1 second"),
				)
				assert.isTrue(Exit.isFailure(firstExit))
				assert.isTrue(Exit.isFailure(secondExit))
				yield* until(Ref.get(closed), (n) => n === 2)
			}).pipe(Effect.scoped),
	)
	it.live(
		"notifies the server even when a failure observer cancels the publisher",
		() =>
			Effect.gen(function* () {
				const { b, left, ba, started, closed } = yield* setup
				yield* Effect.forkScoped(b.Hold())
				yield* Queue.take(started)
				yield* Effect.raceFirst(
					Effect.flip(left.await),
					Queue.fail(ba, TransportError.make({ cause: Cause.empty })),
				)
				yield* until(Ref.get(closed), (count) => count === 1)
			}).pipe(Effect.scoped),
	)

	it.live("discards stale sessions before decoding their RPC payload", () =>
		Effect.gen(function* () {
			const { a, ab, right } = yield* setup
			const stale = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Json),
			)({
				session: "retired",
				endpoint: "main",
				direction: "request",
				priority: "control",
				message: "invalid",
			})
			yield* Queue.offer(ab, new TextEncoder().encode(stale + "\n"))
			yield* until(right.diagnostics, (s) => s.stale === 1)
			const pong = yield* a.Ping()
			assert.equal(pong, "pong")
		}).pipe(Effect.scoped),
	)
	it.live(
		"writes queued control frames before queued data and log frames",
		() =>
			Effect.gen(function* () {
				const { peer, send, gate, started, written } = yield* capture
				yield* send("1", "Flood")
				yield* Deferred.await(started)
				const logs = yield* Effect.forEach(
					Array.range(2, 8),
					(id) => send(String(id), "Flood"),
					{ concurrency: "unbounded" },
				).pipe(Effect.forkScoped)
				yield* until(peer.diagnostics, (stats) => stats.outgoing === 8)
				assert.equal(logs.pollUnsafe(), undefined)
				yield* send("9", "Hold")
				yield* send("10", "Ping")
				yield* Deferred.succeed(gate, undefined)
				const frames = yield* Effect.forEach(Array.range(1, 10), () =>
					Queue.take(written),
				).pipe(Effect.timeout("1 second"))
				yield* Fiber.join(logs)
				assert.deepEqual(
					Array.map(frames, (frame) => frame.priority),
					["log", "control", "data", ...Array.makeBy(7, () => "log")],
				)
			}).pipe(Effect.scoped),
	)
	it.live(
		"does not write a request canceled while queued behind a blocked writer",
		() =>
			Effect.gen(function* () {
				const { peer, send, gate, started, written } = yield* capture
				yield* send("writing", "Hold")
				yield* Deferred.await(started)
				const client = yield* RpcClient.make(Group, {
					generateRequestId: () => RpcMessage.RequestId("canceled"),
				}).pipe(
					Effect.provideService(
						RpcClient.Protocol,
						peer.clientProtocol("main"),
					),
				)
				const canceled = yield* Effect.forkScoped(client.Hold())
				yield* until(peer.diagnostics, (s) => s.outgoing === 2)
				yield* Fiber.interrupt(canceled).pipe(Effect.timeout("1 second"))
				const stats = yield* peer.diagnostics
				assert.equal(stats.outgoing, 1)
				yield* send("after", "Hold")
				yield* Deferred.succeed(gate, undefined)
				const first = yield* Queue.take(written)
				const second = yield* Queue.take(written).pipe(
					Effect.timeout("1 second"),
				)
				assert.equal(first.message.id, "writing")
				assert.equal(second.message.id, "after")
			}).pipe(Effect.scoped),
	)

	it.live(
		"keeps identical request ids and RPC tags independent while servers start late",
		() =>
			Effect.gen(function* () {
				const Text = RpcGroup.make(Rpc.make("Echo", { success: Schema.String }))
				const Number = RpcGroup.make(Rpc.make("Echo", { success: Schema.Int }))
				const ab = yield* Queue.bounded<Uint8Array>(4)
				const ba = yield* Queue.bounded<Uint8Array>(4)
				const left = yield* Port.make(
					{
						input: Stream.fromQueue(ba),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
					},
					{
						session: "current",
						serve: {},
						call: { text: Text, number: Number },
						limits: { data: 2 },
					},
				)
				const right = yield* Port.make(
					{
						input: Stream.fromQueue(ab),
						output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ba, bytes)),
					},
					{
						session: "current",
						serve: { text: Text, number: Number },
						call: {},
						limits: { data: 2 },
					},
				)
				const text = yield* RpcClient.make(Text, {
					generateRequestId: () => RpcMessage.RequestId("same"),
				}).pipe(
					Effect.provideService(
						RpcClient.Protocol,
						left.clientProtocol("text"),
					),
				)
				const number = yield* RpcClient.make(Number, {
					generateRequestId: () => RpcMessage.RequestId("same"),
				}).pipe(
					Effect.provideService(
						RpcClient.Protocol,
						left.clientProtocol("number"),
					),
				)
				const first = yield* Effect.forkScoped(text.Echo())
				const second = yield* Effect.forkScoped(number.Echo())
				yield* until(right.diagnostics, (s) => s.incoming === 2)
				const textHandlers = yield* Text.toHandlers({
					Echo: () => Effect.succeed("text result"),
				})
				const numberHandlers = yield* Number.toHandlers({
					Echo: () => Effect.succeed(42),
				})
				yield* RpcServer.make(Number).pipe(
					Effect.provideContext(numberHandlers),
					Effect.provideService(
						RpcServer.Protocol,
						right.serverProtocol("number"),
					),
					Effect.forkScoped,
				)
				const numberResult = yield* Fiber.join(second)
				assert.equal(numberResult, 42)
				const pending = yield* left.diagnostics
				assert.equal(pending.outgoing, 1)
				yield* RpcServer.make(Text).pipe(
					Effect.provideContext(textHandlers),
					Effect.provideService(
						RpcServer.Protocol,
						right.serverProtocol("text"),
					),
					Effect.forkScoped,
				)
				const textResult = yield* Fiber.join(first)
				assert.equal(textResult, "text result")
				const final = yield* left.diagnostics
				assert.equal(final.outgoing, 0)
				assert.equal(final.highWaterOutgoing, 2)
			}).pipe(Effect.scoped, Effect.timeout("2 seconds")),
	)

	it.live("fails the connection when a request mailbox overflows", () =>
		Effect.gen(function* () {
			const input = yield* Queue.unbounded<Uint8Array>()
			const peer = yield* Port.make(
				{ input: Stream.fromQueue(input), output: Sink.drain },
				{
					session: "current",
					serve: { main: Group },
					call: {},
				},
			)
			const first = yield* encode({
				session: "current",
				endpoint: "main",
				direction: "request",
				priority: "data",
				message: request("held", "Hold"),
			})
			yield* Queue.offer(input, first)
			yield* until(peer.diagnostics, (s) => s.incoming === 1)
			// The worker is waiting for its server. Three extra messages exceed its two slots.
			const interrupt = yield* encode({
				session: "current",
				endpoint: "main",
				direction: "request",
				priority: "control",
				message: { _tag: "Interrupt", requestId: "held" },
			})
			yield* Effect.forEach(Array.range(1, 3), () =>
				Queue.offer(input, interrupt),
			)
			const failure = yield* Effect.flip(peer.await).pipe(
				Effect.timeout("1 second"),
			)
			assert.include(
				Cause.pretty(failure.cause),
				"RPC request mailbox overflow",
			)
			const disconnected = yield* Queue.take(
				peer.serverProtocol("main").disconnects,
			)
			assert.equal(disconnected, 0)
		}).pipe(Effect.scoped),
	)
})
