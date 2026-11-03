import {
	Array,
	Cause,
	Context,
	Data,
	Deferred,
	Effect,
	Fiber,
	FiberSet,
	HashMap,
	Option,
	Queue,
	Record,
	Result,
	Schema,
	Sink,
	Stream,
	TxQueue,
	TxRef,
} from "effect"
import {
	RpcClient,
	RpcClientError,
	RpcSerialization,
	RpcServer,
} from "effect/rpc"
import type { Rpc, RpcGroup, RpcMessage } from "effect/rpc"
import { TransportError } from "../Errors"

export type Priority = "control" | "data" | "log"
export const Priority = Context.Reference<Priority>(
	"@graftland/remote/internal/port/Priority",
	{ defaultValue: () => "data" },
)
export interface Channel {
	readonly input: Stream.Stream<Uint8Array, TransportError>
	readonly output: Sink.Sink<unknown, Uint8Array, unknown, TransportError>
}
type Endpoint = Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">

export interface Options {
	readonly session: string
	readonly serve: Readonly<Record<string, Endpoint>>
	readonly call: Readonly<Record<string, Endpoint>>
	/** Limits are shared across endpoints, separately for each direction.
	 * Each peer's inbound limits must accommodate the other's outbound limits. */
	readonly limits?: Partial<Record<Priority, number>>
}
export interface Diagnostics {
	readonly incoming: number
	readonly outgoing: number
	readonly highWaterIncoming: number
	readonly highWaterOutgoing: number
	readonly stale: number
}
class RequestKey extends Data.Class<{
	readonly endpoint: string
	readonly id: string | number
}> {}
interface Lane<A> {
	readonly queue: Queue.Queue<A, Cause.Done>
	readonly priority: Priority
	readonly sent: boolean
}
const Frame = Schema.Struct({
	session: Schema.String,
	endpoint: Schema.String,
	direction: Schema.Literals(["request", "response"]),
	priority: Schema.Literals(["control", "data", "log"]),
	message: Schema.Unknown,
})
type Frame = typeof Frame.Type
interface Pending {
	readonly frame: Frame
	readonly request: Option.Option<RequestKey>
}
const Id = Schema.Union([Schema.String, Schema.Finite])
// Only routing fields belong to this transport. The RPC serialization codec
// validates payloads, chunks and exits. EncodedSchema requires binary payloads
// in Effect 4.1.2 and cannot describe these JSON codec messages.
const isRequest = Schema.is(
	Schema.Union([
		Schema.TaggedStruct("Request", { id: Id, tag: Schema.String }),
		Schema.TaggedStruct("Ack", { requestId: Id }),
		Schema.TaggedStruct("Interrupt", { requestId: Id }),
		Schema.TaggedStruct("Eof", {}),
	]),
)
const isResponse = Schema.is(
	Schema.Union([
		Schema.TaggedStruct("Exit", { requestId: Id }),
		Schema.TaggedStruct("Chunk", { requestId: Id }),
		Schema.TaggedStruct("Defect", { defect: Schema.Unknown }),
	]),
)
const Request = Schema.declare<
	Exclude<RpcMessage.FromClientEncoded, RpcMessage.Ping>
>((input): input is Exclude<RpcMessage.FromClientEncoded, RpcMessage.Ping> =>
	isRequest(input),
)
const Response = Schema.declare<
	Exclude<
		RpcMessage.FromServerEncoded,
		RpcMessage.Pong | RpcMessage.ClientProtocolError | RpcMessage.RequestEncoded
	>
>(
	(
		input,
	): input is Exclude<
		RpcMessage.FromServerEncoded,
		RpcMessage.Pong | RpcMessage.ClientProtocolError | RpcMessage.RequestEncoded
	> => isResponse(input),
)
const error = (message: string) =>
	TransportError.make({ cause: Cause.die(new Error(message)) })
const rpcError = (cause: Cause.Cause<TransportError>) =>
	RpcClientError.RpcClientError.make({
		reason: RpcClientError.RpcClientDefect.make({
			message: "Remote connection failed",
			cause,
		}),
	})
const priority = (group: Endpoint, tag: string): Priority => {
	const rpc = group.requests.get(tag)
	return rpc === undefined ? "data" : Context.get(rpc.annotations, Priority)
}
const mailbox = <A>(priority: Priority) =>
	Queue.dropping<A, Cause.Done>(2).pipe(
		Effect.map((queue): Lane<A> => ({ queue, priority, sent: false })),
	)
const deliver = Effect.fnUntraced(function* <A>(lane: Lane<A>, message: A) {
	// One unacknowledged chunk and its terminal Exit may coexist.
	if (!(yield* Queue.offer(lane.queue, message)))
		return yield* error("RPC request mailbox overflow")
})

/** One RPC client/server per declared endpoint; servers may start after the port. */
export const make = Effect.fnUntraced(function* (
	bytes: Channel,
	options: Options,
) {
	const limits = { control: 8, data: 16, log: 2, ...options.limits }
	const workers = yield* FiberSet.make<void, TransportError>()
	const incoming = yield* TxRef.make(
		HashMap.empty<RequestKey, Lane<RpcMessage.FromClientEncoded>>(),
	)
	const outgoing = yield* TxRef.make(
		HashMap.empty<RequestKey, Lane<RpcMessage.FromServerEncoded>>(),
	)
	// Mirror the set's terminal cause into transactions so admission and enqueue waiters wake.
	const status = yield* TxRef.make({
		failure: Option.none<Cause.Cause<TransportError>>(),
		highWaterIncoming: 0,
		highWaterOutgoing: 0,
		stale: 0,
	})
	const queues = {
		control: yield* TxQueue.bounded<Pending, Cause.Done>(64),
		data: yield* TxQueue.bounded<Pending, Cause.Done>(32),
		log: yield* TxQueue.bounded<Pending, Cause.Done>(4),
	}
	const servers = yield* Effect.forEach(
		Record.toEntries(options.serve),
		Effect.fnUntraced(function* ([name, group]) {
			return [
				name,
				{
					group,
					ready:
						yield* Deferred.make<
							Parameters<RpcServer.Protocol["Service"]["run"]>[0]
						>(),
					disconnects: yield* Queue.dropping<number>(1),
				},
			] satisfies readonly [string, unknown]
		}),
	).pipe(Effect.map(HashMap.fromIterable))
	const clients = yield* Effect.forEach(
		Record.toEntries(options.call),
		Effect.fnUntraced(function* ([name, group]) {
			return [
				name,
				{
					group,
					ready:
						yield* Deferred.make<
							Parameters<RpcClient.Protocol["Service"]["run"]>[1]
						>(),
				},
			] satisfies readonly [string, unknown]
		}),
	).pipe(Effect.map(HashMap.fromIterable))
	const open = Effect.gen(function* () {
		const { failure } = yield* TxRef.get(status)
		if (Option.isSome(failure)) return yield* Effect.failCause(failure.value)
	})
	const diagnostics = Effect.tx(
		Effect.gen(function* (): Effect.gen.Return<Diagnostics> {
			const state = yield* TxRef.get(status)
			const i = yield* TxRef.get(incoming)
			const o = yield* TxRef.get(outgoing)
			return {
				incoming: HashMap.size(i),
				outgoing: HashMap.size(o),
				highWaterIncoming: state.highWaterIncoming,
				highWaterOutgoing: state.highWaterOutgoing,
				stale: state.stale,
			}
		}),
	)
	const admit = Effect.fnUntraced(function* <A>(
		table: TxRef.TxRef<HashMap.HashMap<RequestKey, Lane<A>>>,
		key: RequestKey,
		lane: Lane<A>,
		direction: "incoming" | "outgoing",
	) {
		yield* Effect.tx(
			Effect.gen(function* () {
				yield* open
				const current = yield* TxRef.get(table)
				if (HashMap.has(current, key))
					return yield* error(
						`Duplicate RPC request id on ${key.endpoint}: ${key.id}`,
					)
				const count = Array.filter(
					Array.fromIterable(HashMap.values(current)),
					(entry) => entry.priority === lane.priority,
				).length
				if (count >= limits[lane.priority]) {
					if (direction === "outgoing") return yield* Effect.txRetry
					return yield* error(
						`RPC admission limit exceeded for ${lane.priority}`,
					)
				}
				yield* TxRef.set(table, HashMap.set(current, key, lane))
				yield* TxRef.update(status, (state) =>
					direction === "incoming"
						? {
								...state,
								highWaterIncoming: Math.max(
									state.highWaterIncoming,
									HashMap.size(current) + 1,
								),
							}
						: {
								...state,
								highWaterOutgoing: Math.max(
									state.highWaterOutgoing,
									HashMap.size(current) + 1,
								),
							},
				)
			}),
		)
	})
	const remove = Effect.fnUntraced(function* <A>(
		table: TxRef.TxRef<HashMap.HashMap<RequestKey, Lane<A>>>,
		key: RequestKey,
		lane: Lane<A>,
	) {
		yield* TxRef.update(table, HashMap.remove(key))
		yield* Queue.end(lane.queue)
	})
	const enqueue = (
		frame: Frame,
		request: Option.Option<RequestKey> = Option.none(),
	) =>
		Effect.tx(
			open.pipe(
				Effect.andThen(
					TxQueue.offer(queues[frame.priority], { frame, request }).pipe(
						Effect.flatMap((accepted) =>
							accepted ? Effect.void : error("Remote output has ended"),
						),
					),
				),
				Effect.asVoid,
			),
		)
	const frame = (
		endpoint: string,
		direction: Frame["direction"],
		p: Priority,
		message: unknown,
	): Frame => ({
		session: options.session,
		endpoint,
		direction,
		priority: p,
		message,
	})
	// Protocol sends are owned too: interrupting a caller cancels admission or enqueue.
	const send = Effect.fnUntraced(function* (
		effect: Effect.Effect<void, TransportError>,
	) {
		const fiber = yield* FiberSet.run(
			workers,
			open.pipe(Effect.andThen(effect)),
		)
		const result = yield* Fiber.await(fiber).pipe(
			Effect.onInterrupt(() => Fiber.interrupt(fiber)),
		)
		// Group teardown interrupts this worker; callers still receive the connection cause.
		yield* open
		yield* result
	})
	const cancel = Effect.fnUntraced(function* (key: RequestKey) {
		const canceled = yield* Effect.tx(
			Effect.gen(function* () {
				const table = yield* TxRef.get(outgoing)
				const lane = HashMap.get(table, key)
				if (Option.isNone(lane))
					return Option.none<Lane<RpcMessage.FromServerEncoded>>()
				if (lane.value.sent) {
					yield* enqueue(
						frame(key.endpoint, "request", "control", {
							_tag: "Interrupt",
							requestId: key.id,
						}),
					)
					return Option.none<Lane<RpcMessage.FromServerEncoded>>()
				}
				yield* TxRef.set(outgoing, HashMap.remove(table, key))
				return lane
			}),
		)
		if (Option.isSome(canceled)) yield* Queue.end(canceled.value.queue)
	})
	const clientProtocol = (endpoint: string): RpcClient.Protocol["Service"] => {
		// Accessors accept endpoints declared when the port was created.
		const client = HashMap.getUnsafe(clients, endpoint)
		return RpcClient.Protocol.of({
			codecFor: RpcSerialization.json.codecFor,
			supportsAck: true,
			supportsTransferables: false,
			run: (_id, receive) =>
				Deferred.succeed(client.ready, receive).pipe(
					Effect.andThen(FiberSet.join(workers)),
					Effect.catchCause((cause) =>
						receive({ _tag: "ClientProtocolError", error: rpcError(cause) }),
					),
					Effect.andThen(Effect.never),
				),
			send: (_id, message) =>
				send(
					Effect.gen(function* () {
						if (message._tag === "Request") {
							if (message.discard === true || message.isNotification === true)
								return yield* error(
									"Discard and notification requests are not supported",
								)
							const key = new RequestKey({ endpoint, id: message.id })
							const lane = yield* mailbox<RpcMessage.FromServerEncoded>(
								priority(client.group, message.tag),
							)
							yield* admit(outgoing, key, lane, "outgoing")
							yield* FiberSet.run(
								workers,
								Stream.fromQueue(lane.queue).pipe(
									Stream.runForEach(
										Effect.fnUntraced(function* (response) {
											const receive = yield* Deferred.await(client.ready)
											if (response._tag === "Exit")
												yield* remove(outgoing, key, lane)
											yield* receive(response)
										}),
									),
								),
							)
							yield* enqueue(
								frame(endpoint, "request", lane.priority, message),
								Option.some(key),
							)
						} else if (message._tag === "Interrupt") {
							yield* cancel(new RequestKey({ endpoint, id: message.requestId }))
						} else if (message._tag === "Ack") {
							yield* enqueue(frame(endpoint, "request", "control", message))
						}
					}),
				).pipe(Effect.mapError((failure) => rpcError(Cause.fail(failure)))),
		})
	}
	const serverProtocol = (endpoint: string): RpcServer.Protocol["Service"] => {
		// Accessors accept endpoints declared when the port was created.
		const server = HashMap.getUnsafe(servers, endpoint)
		return RpcServer.Protocol.of({
			codecFor: RpcSerialization.json.codecFor,
			supportsAck: true,
			supportsTransferables: false,
			supportsSpanPropagation: false,
			supportsNotifications: false,
			clientIds: Effect.succeed(new Set([0])),
			initialMessage: Effect.succeedNone,
			disconnects: server.disconnects,
			end: () => Effect.void,
			run: (receive) =>
				Deferred.succeed(server.ready, receive).pipe(
					Effect.andThen(Effect.never),
				),
			send: (_id, message) =>
				send(
					Effect.gen(function* () {
						if (message._tag === "Chunk" || message._tag === "Exit") {
							const key = new RequestKey({ endpoint, id: message.requestId })
							const lane = yield* TxRef.get(incoming).pipe(
								Effect.map(HashMap.get(key)),
							)
							if (Option.isNone(lane)) return
							yield* enqueue(
								frame(
									endpoint,
									"response",
									message._tag === "Exit" ? "control" : lane.value.priority,
									message,
								),
							)
							if (message._tag === "Exit")
								yield* remove(incoming, key, lane.value)
						} else
							yield* enqueue(frame(endpoint, "response", "control", message))
					}),
				).pipe(Effect.catchTag("TransportError", () => Effect.void)),
		})
	}
	const next = Effect.tx(
		Effect.gen(function* () {
			yield* open
			for (const p of [
				"control",
				"data",
				"log",
			] satisfies ReadonlyArray<Priority>) {
				const pending = yield* TxQueue.poll(queues[p])
				if (Option.isNone(pending)) continue
				const { frame, request } = pending.value
				if (Option.isSome(request)) {
					const table = yield* TxRef.get(outgoing)
					const lane = HashMap.get(table, request.value)
					if (Option.isNone(lane)) return Option.none<Frame>()
					yield* TxRef.set(
						outgoing,
						HashMap.set(table, request.value, { ...lane.value, sent: true }),
					)
				}
				return Option.some(frame)
			}
			if (
				(yield* TxQueue.isDone(queues.control)) &&
				(yield* TxQueue.isDone(queues.data)) &&
				(yield* TxQueue.isDone(queues.log))
			)
				return yield* Cause.done()
			return yield* Effect.txRetry
		}),
	)
	const writer = Stream.fromEffectRepeat(next).pipe(
		Stream.filterMap(Result.fromOption(() => undefined)),
		Stream.mapEffect((frame) =>
			Schema.encodeEffect(Schema.fromJsonString(Frame))(frame).pipe(
				Effect.mapError((cause) =>
					TransportError.make({ cause: Cause.fail(cause) }),
				),
			),
		),
		Stream.map((json) => new TextEncoder().encode(json + "\n")),
		Stream.run(bytes.output),
	)
	const parser = RpcSerialization.makeNdjson({
		maxBufferSize: 1024 * 1024,
	}).makeUnsafe()
	const read = Effect.fnUntraced(function* (raw: unknown) {
		const current = yield* Schema.decodeUnknownEffect(Frame)(raw).pipe(
			Effect.mapError((cause) =>
				TransportError.make({ cause: Cause.fail(cause) }),
			),
		)
		if (current.session !== options.session) {
			yield* TxRef.update(status, (state) => ({
				...state,
				stale: state.stale + 1,
			}))
			return
		}
		if (current.direction === "request") {
			const server = HashMap.get(servers, current.endpoint)
			if (Option.isNone(server))
				return yield* error(`Unknown RPC server endpoint: ${current.endpoint}`)
			const message = yield* Schema.decodeUnknownEffect(Request)(
				current.message,
			).pipe(
				Effect.mapError((cause) =>
					TransportError.make({ cause: Cause.fail(cause) }),
				),
			)
			if (message._tag === "Eof") return yield* error("Remote connection ended")
			const key = new RequestKey({
				endpoint: current.endpoint,
				id: message._tag === "Request" ? message.id : message.requestId,
			})
			if (message._tag === "Request") {
				const p = priority(server.value.group, message.tag)
				if (p !== current.priority)
					return yield* error("RPC priority does not match its contract")
				const lane = yield* mailbox<RpcMessage.FromClientEncoded>(p)
				yield* admit(incoming, key, lane, "incoming")
				yield* FiberSet.run(
					workers,
					Stream.fromQueue(lane.queue).pipe(
						Stream.runForEach(
							Effect.fnUntraced(function* (request) {
								const receive = yield* Deferred.await(server.value.ready)
								yield* receive(0, request)
							}),
						),
					),
				)
				yield* deliver(lane, message)
			} else {
				const lane = yield* TxRef.get(incoming).pipe(
					Effect.map(HashMap.get(key)),
				)
				if (Option.isSome(lane)) yield* deliver(lane.value, message)
			}
		} else {
			const message = yield* Schema.decodeUnknownEffect(Response)(
				current.message,
			).pipe(
				Effect.mapError((cause) =>
					TransportError.make({ cause: Cause.fail(cause) }),
				),
			)
			if (message._tag === "Defect")
				return yield* TransportError.make({ cause: Cause.die(message.defect) })
			const key = new RequestKey({
				endpoint: current.endpoint,
				id: message.requestId,
			})
			const lane = yield* TxRef.get(outgoing).pipe(Effect.map(HashMap.get(key)))
			if (Option.isSome(lane)) yield* deliver(lane.value, message)
		}
	})
	const reader = bytes.input.pipe(
		Stream.runForEach(
			Effect.fnUntraced(function* (chunk) {
				const frames = yield* Effect.try({
					try: () => parser.decode(chunk),
					catch: (cause) => TransportError.make({ cause: Cause.die(cause) }),
				})
				yield* Effect.forEach(frames, read, { discard: true })
			}),
		),
		Effect.andThen(error("Remote connection ended")),
	)
	// This supervisor belongs to the port's scope, outside the set it interrupts.
	// Publishing failure and disconnects is one uninterruptible handoff.
	yield* FiberSet.join(workers).pipe(
		Effect.catchCause((cause) =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					yield* TxRef.update(status, (state) => ({
						...state,
						failure: Option.some(cause),
					}))
					for (const server of HashMap.values(servers))
						yield* Queue.offer(server.disconnects, 0)
					yield* FiberSet.clear(workers)
					yield* Effect.tx(
						TxRef.set(incoming, HashMap.empty()).pipe(
							Effect.andThen(TxRef.set(outgoing, HashMap.empty())),
						),
					)
				}),
			),
		),
		Effect.forkScoped,
	)
	const writing = yield* FiberSet.run(workers, writer)
	yield* FiberSet.run(workers, reader)
	return {
		clientProtocol,
		serverProtocol,
		diagnostics,
		await: FiberSet.join(workers).pipe(Effect.andThen(Effect.never)),
		fail: (failure: TransportError) =>
			FiberSet.run(workers, Effect.fail(failure)).pipe(Effect.asVoid),
		end: Effect.tx(
			Effect.forEach(Record.values(queues), TxQueue.end, { discard: true }),
		).pipe(Effect.andThen(Fiber.join(writing))),
	}
})
