import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	FiberMap,
	HashMap,
	Option,
	Queue,
	Ref,
	Schema,
	Sink,
	Stream,
	TxRef,
} from "effect"
import {
	RpcClient,
	RpcClientError,
	RpcGroup,
	RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/rpc"
import type { Rpc } from "effect/rpc"
import { TransportError } from "../Errors"

export type Priority = "control" | "data" | "log"
export const Priority = Context.Reference<Priority>(
	"@graftland/remote/internal/duplex/Priority",
	{ defaultValue: () => "data" },
)
export interface Channel {
	readonly input: Stream.Stream<Uint8Array, TransportError>
	readonly output: Sink.Sink<unknown, Uint8Array, unknown, TransportError>
}
const Id = Schema.Union([Schema.String, Schema.Finite])
const Reason = Schema.Union([
	Schema.TaggedStruct("Fail", { error: Schema.Unknown }),
	Schema.TaggedStruct("Die", { defect: Schema.Unknown }),
	Schema.TaggedStruct("Interrupt", {
		fiberId: Schema.UndefinedOr(Schema.NullOr(Schema.Finite)),
	}),
])
const Request = Schema.Union([
	Schema.TaggedStruct("Request", {
		id: Id,
		tag: Schema.String,
		payload: Schema.Unknown,
		headers: Schema.Array(
			Schema.mutable(Schema.Tuple([Schema.String, Schema.String])),
		),
	}),
	Schema.TaggedStruct("Ack", { requestId: Id }),
	Schema.TaggedStruct("Interrupt", { requestId: Id }),
	Schema.TaggedStruct("Eof", {}),
])
const Response = Schema.Union([
	Schema.TaggedStruct("Exit", {
		requestId: Id,
		exit: Schema.Union([
			Schema.TaggedStruct("Success", { value: Schema.Unknown }),
			Schema.TaggedStruct("Failure", { cause: Schema.Array(Reason) }),
		]),
	}),
	Schema.TaggedStruct("Chunk", {
		requestId: Id,
		values: Schema.NonEmptyArray(Schema.Unknown),
	}),
	Schema.TaggedStruct("Defect", { defect: Schema.Unknown }),
])
const Frame = Schema.Struct({
	session: Schema.String,
	direction: Schema.Literals(["request", "response"]),
	priority: Schema.Literals(["control", "data", "log"]),
	message: Schema.Unknown,
})
type Frame = typeof Frame.Type
interface Lane<A> {
	readonly queue: Queue.Queue<A, Cause.Done>
	readonly priority: Priority
	readonly sent: Ref.Ref<boolean>
}
export interface Options {
	readonly session: string
	readonly local: RpcGroup.RpcGroup<Rpc.Any>
	readonly remote: RpcGroup.RpcGroup<Rpc.Any>
	/** Per-priority limits for both directions. Each peer's inbound limit must
	 * be at least the other peer's outbound limit. Local peers share defaults;
	 * the network runner handshake must exchange and reconcile limits before RPC starts. */
	readonly limits?: Partial<Record<Priority, number>>
}
const error = (message: string) =>
	TransportError.make({ cause: Cause.die(new Error(message)) })
const rpcError = (cause: unknown) =>
	RpcClientError.RpcClientError.make({
		reason: RpcClientError.RpcClientDefect.make({
			message: "Remote connection failed",
			cause,
		}),
	})

/** One reader and writer; request lanes preserve order while independent streams backpressure. */
export const make = Effect.fnUntraced(function* (
	channel: Channel,
	options: Options,
) {
	const limits = { control: 8, data: 16, log: 2, ...options.limits }
	const failed = yield* Deferred.make<never, TransportError>()
	const closing = yield* Ref.make(false)
	const incoming = yield* TxRef.make(
		HashMap.empty<string, Lane<typeof Request.Type>>(),
	)
	const outgoing = yield* TxRef.make(
		HashMap.empty<string, Lane<typeof Response.Type>>(),
	)
	const workers = yield* FiberMap.make<string, void, never>()
	const queues = {
		control: yield* Queue.bounded<Frame>(64),
		data: yield* Queue.bounded<Frame>(32),
		log: yield* Queue.bounded<Frame>(4),
	}
	const wake = yield* Queue.dropping<void>(1)
	const disconnects = yield* Queue.bounded<number>(1)
	const clientReady =
		yield* Deferred.make<
			(message: RpcMessage.FromServerEncoded) => Effect.Effect<void>
		>()
	const serverReady =
		yield* Deferred.make<
			(id: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>
		>()
	const stats = yield* Ref.make({
		incoming: 0,
		outgoing: 0,
		highWaterIncoming: 0,
		highWaterOutgoing: 0,
		stale: 0,
	})
	const fail = (failure: TransportError) =>
		Effect.gen(function* () {
			if (yield* Deferred.fail(failed, failure))
				yield* Queue.offer(disconnects, 0)
		})
	const report = (cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.void
			: fail(TransportError.make({ cause }))
	const race = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.raceFirst(effect, Deferred.await(failed))
	const priority = (
		group: RpcGroup.RpcGroup<Rpc.Any>,
		tag: string,
	): Priority => {
		const rpc = group.requests.get(tag)
		return rpc === undefined ? "data" : Context.get(rpc.annotations, Priority)
	}
	const refresh = Effect.gen(function* () {
		const i = yield* TxRef.get(incoming).pipe(Effect.map(HashMap.size))
		const o = yield* TxRef.get(outgoing).pipe(Effect.map(HashMap.size))
		yield* Ref.update(stats, (s) => ({
			...s,
			incoming: i,
			outgoing: o,
			highWaterIncoming: Math.max(s.highWaterIncoming, i),
			highWaterOutgoing: Math.max(s.highWaterOutgoing, o),
		}))
	})
	const enqueue = (
		direction: Frame["direction"],
		p: Priority,
		message: unknown,
	) =>
		race(
			Effect.gen(function* () {
				yield* Queue.offer(queues[p], {
					session: options.session,
					direction,
					priority: p,
					message,
				})
				yield* Queue.offer(wake, undefined)
			}),
		)
	const remove = <A>(
		map: TxRef.TxRef<HashMap.HashMap<string, Lane<A>>>,
		id: string,
		lane: Lane<A>,
	) =>
		Effect.gen(function* () {
			yield* TxRef.update(map, HashMap.remove(id))
			yield* Queue.end(lane.queue)
			yield* refresh
		})
	const admit = <A>(
		map: TxRef.TxRef<HashMap.HashMap<string, Lane<A>>>,
		id: string,
		p: Priority,
		wait = false,
	) =>
		Effect.gen(function* () {
			const lane: Lane<A> = {
				queue: yield* Queue.bounded<A, Cause.Done>(2),
				priority: p,
				sent: yield* Ref.make(false),
			}
			yield* Effect.tx(
				Effect.gen(function* () {
					const current = yield* TxRef.get(map)
					if (HashMap.has(current, id))
						return yield* error(`Duplicate RPC request id: ${id}`)
					const full =
						Array.filter(
							Array.fromIterable(HashMap.values(current)),
							(lane) => lane.priority === p,
						).length >= limits[p]
					if (full) {
						if (wait) return yield* Effect.txRetry
						return yield* error(`RPC admission limit exceeded for ${p}`)
					}
					yield* TxRef.set(map, HashMap.set(current, id, lane))
				}),
			)
			yield* refresh
			return lane
		})
	const deliver = <A>(lane: Lane<A>, message: A) =>
		Effect.gen(function* () {
			// ACKs allow at most one outstanding stream chunk; overflow is a protocol violation.
			if (!Queue.offerUnsafe(lane.queue, message))
				return yield* error("RPC request mailbox overflow")
		})
	const clientProtocol = RpcClient.Protocol.of({
		codecFor: RpcSerialization.json.codecFor,
		supportsAck: true,
		supportsTransferables: false,
		run: (_id, receive) =>
			Effect.gen(function* () {
				yield* Deferred.succeed(clientReady, receive)
				const failure = yield* Effect.flip(Deferred.await(failed))
				yield* receive({
					_tag: "ClientProtocolError",
					error: rpcError(failure),
				})
				return yield* Effect.never
			}),
		send: (_id, message) =>
			Effect.gen(function* () {
				if (yield* Deferred.isDone(failed)) return yield* Deferred.await(failed)
				if (message._tag === "Request") {
					if (message.discard === true || message.isNotification === true)
						return yield* error(
							"Discard and notification requests are not supported",
						)
					const id = String(message.id)
					const p = priority(options.remote, message.tag)
					const lane = yield* race(admit(outgoing, id, p, true))
					yield* FiberMap.run(
						workers,
						`out:${id}`,
						Stream.fromQueue(lane.queue).pipe(
							Stream.runForEach((response) =>
								Effect.gen(function* () {
									const receive = yield* Deferred.await(clientReady)
									if (response._tag === "Exit")
										yield* remove(outgoing, id, lane)
									yield* receive(response)
								}),
							),
							race,
							Effect.catchCause(report),
						),
					)
					yield* enqueue("request", p, message)
				} else if (message._tag === "Ack" || message._tag === "Interrupt") {
					const id = String(message.requestId)
					const lane = yield* TxRef.get(outgoing).pipe(
						Effect.map(HashMap.get(id)),
					)
					if (Option.isNone(lane)) return
					if (
						message._tag === "Interrupt" &&
						!(yield* Ref.get(lane.value.sent))
					) {
						yield* remove(outgoing, id, lane.value)
						return
					}
					yield* enqueue("request", "control", message)
				}
			}).pipe(Effect.mapError(rpcError)),
	})
	const serverProtocol = RpcServer.Protocol.of({
		codecFor: RpcSerialization.json.codecFor,
		supportsAck: true,
		supportsTransferables: false,
		supportsSpanPropagation: false,
		supportsNotifications: false,
		clientIds: Effect.succeed(new Set([0])),
		initialMessage: Effect.succeedNone,
		disconnects,
		end: () => Effect.void,
		run: (receive) =>
			Effect.gen(function* () {
				yield* Deferred.succeed(serverReady, receive)
				return yield* Effect.never
			}),
		send: (_id, message) =>
			Effect.gen(function* () {
				if (message._tag === "Chunk" || message._tag === "Exit") {
					const id = String(message.requestId)
					const lane = yield* TxRef.get(incoming).pipe(
						Effect.map(HashMap.get(id)),
					)
					if (Option.isNone(lane)) return
					yield* enqueue(
						"response",
						message._tag === "Exit" ? "control" : lane.value.priority,
						message,
					)
					if (message._tag === "Exit") yield* remove(incoming, id, lane.value)
				} else yield* enqueue("response", "control", message)
			}).pipe(Effect.orDie),
	})
	const next = Effect.suspend((): Effect.Effect<Frame, Cause.Done> =>
		Effect.gen(function* () {
			for (const p of ["control", "data", "log"] as const) {
				const frame = yield* Queue.poll(queues[p])
				if (Option.isSome(frame)) return frame.value
			}
			if (yield* Ref.get(closing)) return yield* Cause.done()
			yield* Queue.take(wake)
			return yield* next
		}),
	)
	const writer = yield* Stream.fromEffectRepeat(next).pipe(
		Stream.filterEffect((frame) =>
			Effect.gen(function* () {
				if (frame.direction !== "request") return true
				const message = yield* Schema.decodeUnknownEffect(Request)(
					frame.message,
				)
				if (message._tag !== "Request") return true
				const lane = yield* TxRef.get(outgoing).pipe(
					Effect.map(HashMap.get(String(message.id))),
				)
				if (Option.isNone(lane)) return false
				yield* Ref.set(lane.value.sent, true)
				return true
			}),
		),
		Stream.mapEffect((frame) =>
			Schema.encodeEffect(Schema.fromJsonString(Frame))(frame).pipe(
				Effect.map((json) => new TextEncoder().encode(json + "\n")),
			),
		),
		Stream.run(channel.output),
		race,
		Effect.tapCause(report),
		Effect.forkScoped,
	)
	const parser = RpcSerialization.makeNdjson({
		maxBufferSize: 1024 * 1024,
	}).makeUnsafe()
	const reader = yield* channel.input.pipe(
		Stream.runForEach((bytes) =>
			Effect.gen(function* () {
				const frames = yield* Effect.try({
					try: () => parser.decode(bytes),
					catch: (cause) => TransportError.make({ cause: Cause.die(cause) }),
				})
				for (const raw of frames) {
					const frame = yield* Schema.decodeUnknownEffect(Frame)(raw)
					if (frame.session !== options.session) {
						yield* Ref.update(stats, (s) => ({ ...s, stale: s.stale + 1 }))
						continue
					}
					if (frame.direction === "request") {
						const message = yield* Schema.decodeUnknownEffect(Request)(
							frame.message,
						)
						if (message._tag === "Eof") {
							yield* fail(error("Remote connection ended"))
							continue
						}
						const id = String(
							message._tag === "Request" ? message.id : message.requestId,
						)
						if (message._tag === "Request") {
							const p = priority(options.local, message.tag)
							if (p !== frame.priority)
								return yield* error("RPC priority does not match its contract")
							const lane = yield* admit(incoming, id, p)
							yield* FiberMap.run(
								workers,
								`in:${id}`,
								Stream.fromQueue(lane.queue).pipe(
									Stream.runForEach((request) =>
										Effect.gen(function* () {
											const receive = yield* Deferred.await(serverReady)
											yield* receive(0, request)
										}),
									),
									race,
									Effect.catchCause(report),
								),
							)
							yield* deliver(lane, message)
						} else {
							const lane = yield* TxRef.get(incoming).pipe(
								Effect.map(HashMap.get(id)),
							)
							if (Option.isSome(lane)) yield* deliver(lane.value, message)
						}
					} else {
						const message = yield* Schema.decodeUnknownEffect(Response)(
							frame.message,
						)
						if (message._tag === "Defect") {
							yield* fail(
								TransportError.make({ cause: Cause.die(message.defect) }),
							)
							continue
						}
						const lane = yield* TxRef.get(outgoing).pipe(
							Effect.map(HashMap.get(String(message.requestId))),
						)
						if (Option.isSome(lane)) yield* deliver(lane.value, message)
					}
				}
			}),
		),
		Effect.andThen(fail(error("Remote connection ended"))),
		race,
		Effect.catchCause(report),
		Effect.forkScoped,
	)
	return {
		clientProtocol,
		serverProtocol,
		failed,
		fail,
		stats,
		reader,
		writer,
		end: Ref.set(closing, true).pipe(
			Effect.andThen(Queue.offer(wake, undefined)),
		),
	}
})
