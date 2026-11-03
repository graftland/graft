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
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"
import * as Duplex from "../src/internal/duplex"
import * as Services from "../src/internal/services"
import { TransportError } from "../src/Errors"

const Group = RpcGroup.make(
	Rpc.make("Hold"),
	Rpc.make("Echo", { payload: { value: Schema.Int }, success: Schema.Int }),
	Rpc.make("Ping", { success: Schema.String }).annotate(
		Duplex.Priority,
		"control",
	),
	Rpc.make("Flood", { success: Schema.Int, stream: true }).annotate(
		Duplex.Priority,
		"log",
	),
)
const group = Services.combine(Group, [])
const until = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean) =>
	effect.pipe(
		Effect.repeat({ schedule: Schedule.spaced("1 millis"), until: predicate }),
		Effect.timeout("2 seconds"),
	)
const setup = Effect.gen(function* () {
	const ab = yield* Queue.bounded<Uint8Array, TransportError | Cause.Done>(4)
	const ba = yield* Queue.bounded<Uint8Array, TransportError | Cause.Done>(4)
	const left = yield* Duplex.make(
		{
			input: Stream.fromQueue(ba),
			output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
		},
		{ session: "current", local: group, remote: group, limits: { data: 2 } },
	)
	const right = yield* Duplex.make(
		{
			input: Stream.fromQueue(ab),
			output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ba, bytes)),
		},
		{ session: "current", local: group, remote: group, limits: { data: 2 } },
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
			Effect.provideService(RpcServer.Protocol, peer.serverProtocol),
			Effect.forkScoped,
		)
	}
	const a = yield* RpcClient.make(Group).pipe(
		Effect.provideService(RpcClient.Protocol, left.clientProtocol),
	)
	const b = yield* RpcClient.make(Group).pipe(
		Effect.provideService(RpcClient.Protocol, right.clientProtocol),
	)
	return { a, b, left, right, ab, ba, closed, started }
})
describe("duplex transport", () => {
	it.live(
		"bounds admitted calls and keeps control usable with saturated data and backpressured logs",
		() =>
			Effect.gen(function* () {
				const { a, left, right } = yield* setup
				const first = yield* Effect.forkScoped(a.Hold())
				const second = yield* Effect.forkScoped(a.Hold())
				yield* until(Ref.get(right.stats), (s) => s.incoming === 2)
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
				yield* until(Ref.get(left.stats), (s) => s.outgoing === 1)
				const values = yield* Fiber.join(calls).pipe(
					Effect.timeout("2 seconds"),
				)
				assert.deepEqual(values, Array.range(0, 99))
				const stats = yield* Ref.get(left.stats)
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
				const outgoing = yield* Ref.get(left.stats)
				const incoming = yield* Ref.get(right.stats)
				assert.isAtMost(outgoing.highWaterOutgoing, 2)
				assert.isAtMost(incoming.highWaterIncoming, 2)
			}).pipe(Effect.scoped),
	)
	it.live(
		"interrupts an admission waiter without leaking a slot and fails waiters on disconnect",
		() =>
			Effect.gen(function* () {
				const { a, left, right } = yield* setup
				const first = yield* Effect.forkScoped(a.Hold())
				yield* Effect.forkScoped(a.Hold())
				yield* until(Ref.get(right.stats), (s) => s.incoming === 2)
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
				yield* until(Ref.get(right.stats), (s) => s.incoming === 2)
				const waiting = yield* Effect.forkScoped(a.Echo({ value: 3 }))
				yield* Effect.yieldNow
				assert.equal(waiting.pollUnsafe(), undefined)
				yield* left.fail(
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
			yield* until(Ref.get(right.stats), (s) => s.incoming === 2)
			const overflow = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Json),
			)({
				session: "current",
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
			const failure = yield* Effect.flip(Deferred.await(right.failed)).pipe(
				Effect.timeout("1 second"),
			)
			assert.include(
				Cause.pretty(failure.cause),
				"RPC admission limit exceeded for data",
			)
			const stats = yield* Ref.get(right.stats)
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
				const { b, left, started, closed } = yield* setup
				yield* Effect.forkScoped(b.Hold())
				yield* Queue.take(started)
				yield* Effect.raceFirst(
					Effect.flip(Deferred.await(left.failed)),
					left.fail(TransportError.make({ cause: Cause.empty })),
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
				direction: "request",
				priority: "control",
				message: "invalid",
			})
			yield* Queue.offer(ab, new TextEncoder().encode(stale + "\n"))
			yield* until(Ref.get(right.stats), (s) => s.stale === 1)
			const pong = yield* a.Ping()
			assert.equal(pong, "pong")
		}).pipe(Effect.scoped),
	)
	it.live(
		"writes queued control frames before queued data and log frames",
		() =>
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>()
				const started = yield* Deferred.make<void>()
				const written = yield* Ref.make<ReadonlyArray<string>>([])
				const peer = yield* Duplex.make(
					{
						input: Stream.never,
						output: Sink.forEach((bytes: Uint8Array) =>
							Effect.gen(function* () {
								yield* Deferred.succeed(started, undefined)
								yield* Deferred.await(gate)
								const frame = yield* Schema.decodeEffect(
									Schema.fromJsonString(
										Schema.Struct({ priority: Schema.String }),
									),
								)(new TextDecoder().decode(bytes))
								yield* Ref.update(written, Array.append(frame.priority))
							}).pipe(
								Effect.mapError((cause) =>
									TransportError.make({ cause: Cause.fail(cause) }),
								),
							),
						),
					},
					{
						session: "current",
						local: group,
						remote: group,
						limits: { log: 8 },
					},
				)
				const send = (id: string, tag: string) =>
					peer.clientProtocol.send(0, {
						_tag: "Request",
						id,
						tag,
						payload: {},
						headers: [],
					})
				yield* send("1", "Flood")
				yield* Deferred.await(started)
				const logs = yield* Effect.forEach(
					Array.range(2, 8),
					(id) => send(String(id), "Flood"),
					{ concurrency: "unbounded" },
				).pipe(Effect.forkScoped)
				yield* until(Ref.get(peer.stats), (stats) => stats.outgoing === 8)
				assert.equal(logs.pollUnsafe(), undefined)
				yield* send("9", "Hold")
				yield* send("10", "Ping")
				yield* Deferred.succeed(gate, undefined)
				const frames = yield* until(Ref.get(written), (s) => s.length === 10)
				yield* Fiber.join(logs)
				assert.deepEqual(frames, [
					"log",
					"control",
					"data",
					...Array.makeBy(7, () => "log"),
				])
			}).pipe(Effect.scoped),
	)
})
