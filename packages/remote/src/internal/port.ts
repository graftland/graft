import { EndOfStream } from "./runner/Framing"
export type { Channel } from "../Transport"
import type { Channel } from "../Transport"
import {
	Array,
	Cause,
	Context,
	Data,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	Option,
	Queue,
	Record,
	Result,
	Schema,
	type Scope,
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
import * as FailureGroup from "./FailureGroup"
import { TransportError } from "../Errors"
import { defaults, type Limits } from "./Limits"
export type Priority = keyof Limits

export const Priority = Context.Reference<Priority>(
	"@graftland/plugin-remote/internal/port/Priority",
	{ defaultValue: () => "data" },
)
type Endpoint = Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">

export interface Options {
	readonly session: string
	readonly serve: Readonly<Record<string, Endpoint>>
	readonly call: Readonly<Record<string, Endpoint>>
	/** Limits are shared across endpoints, separately for each direction.
	 * Each peer's inbound limits must accommodate the other's outbound limits. */
	readonly limits?: Partial<Record<Priority, number>>
}
export interface Port {
	readonly clientProtocol: (endpoint: string) => RpcClient.Protocol["Service"]
	readonly serverProtocol: (endpoint: string) => RpcServer.Protocol["Service"]
	readonly await: Effect.Effect<never, TransportError>
	readonly fail: (error: TransportError) => Effect.Effect<void>
	readonly end: Effect.Effect<void, TransportError>
}
class RequestKey extends Data.Class<{
	readonly endpoint: string
	readonly id: string | number
}> {}
interface RequestState<A> {
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
// validates payloads, chunks and exits before handlers or callers see them. These
// protocol callbacks are an opaque handoff, not validation of a complete RpcMessage.
// EncodedSchema requires binary payloads
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
		Effect.map((queue): RequestState<A> => ({ queue, priority, sent: false })),
	)
const deliver = Effect.fnUntraced(function* <A>(
	requestState: RequestState<A>,
	message: A,
) {
	// One unacknowledged chunk and its terminal Exit may coexist.
	if (!(yield* Queue.offer(requestState.queue, message)))
		return yield* error("RPC request mailbox overflow")
})

type ServerEndpoint = {
	readonly group: Endpoint
	readonly ready: Deferred.Deferred<
		Parameters<RpcServer.Protocol["Service"]["run"]>[0]
	>
	readonly disconnects: Queue.Queue<number>
}
type ClientEndpoint = {
	readonly group: Endpoint
	readonly ready: Deferred.Deferred<
		Parameters<RpcClient.Protocol["Service"]["run"]>[1]
	>
}
interface State {
	readonly bytes: Channel
	readonly options: Options
	readonly limits: Record<Priority, number>
	readonly workers: FailureGroup.FailureGroup<TransportError>
	readonly incoming: TxRef.TxRef<
		HashMap.HashMap<RequestKey, RequestState<RpcMessage.FromClientEncoded>>
	>
	readonly outgoing: TxRef.TxRef<
		HashMap.HashMap<RequestKey, RequestState<RpcMessage.FromServerEncoded>>
	>
	readonly queues: Record<Priority, TxQueue.TxQueue<Pending, Cause.Done>>
	readonly servers: HashMap.HashMap<string, ServerEndpoint>
	readonly clients: HashMap.HashMap<string, ClientEndpoint>
}
const initialize = (bytes: Channel, options: Options) =>
	Effect.gen(function* (): Effect.gen.Return<State, never, Scope.Scope> {
		const limits = { ...defaults, ...options.limits }
		const workers = yield* FailureGroup.make<TransportError>()
		const incoming = yield* TxRef.make(
			HashMap.empty<RequestKey, RequestState<RpcMessage.FromClientEncoded>>(),
		)
		const outgoing = yield* TxRef.make(
			HashMap.empty<RequestKey, RequestState<RpcMessage.FromServerEncoded>>(),
		)
		const queues = {
			control: yield* TxQueue.unbounded<Pending, Cause.Done>(),
			data: yield* TxQueue.unbounded<Pending, Cause.Done>(),
			log: yield* TxQueue.unbounded<Pending, Cause.Done>(),
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
		return {
			bytes,
			options,
			limits,
			workers,
			incoming,
			outgoing,
			queues,
			servers,
			clients,
		}
	})

const admit = Effect.fnUntraced(function* <A>(
	state: State,
	table: TxRef.TxRef<HashMap.HashMap<RequestKey, RequestState<A>>>,
	key: RequestKey,
	requestState: RequestState<A>,
	direction: "incoming" | "outgoing",
) {
	yield* Effect.tx(
		Effect.gen(function* () {
			yield* state.workers.check
			const current = yield* TxRef.get(table)
			const count = Array.filter(
				Array.fromIterable(HashMap.values(current)),
				(entry) => entry.priority === requestState.priority,
			).length
			if (count >= state.limits[requestState.priority]) {
				if (direction === "outgoing") return yield* Effect.txRetry
				return yield* error(
					`RPC admission limit exceeded for ${requestState.priority}`,
				)
			}
			yield* TxRef.set(table, HashMap.set(current, key, requestState))
		}),
	)
})
const remove = Effect.fnUntraced(function* <A>(
	table: TxRef.TxRef<HashMap.HashMap<RequestKey, RequestState<A>>>,
	key: RequestKey,
	requestState: RequestState<A>,
) {
	yield* TxRef.update(table, HashMap.remove(key))
	yield* Queue.end(requestState.queue)
})
const enqueue = (
	state: State,
	frame: Frame,
	request: Option.Option<RequestKey> = Option.none(),
) =>
	Effect.tx(
		state.workers.check.pipe(
			Effect.andThen(
				TxQueue.offer(state.queues[frame.priority], { frame, request }).pipe(
					Effect.flatMap((accepted) =>
						accepted ? Effect.void : error("Remote output has ended"),
					),
				),
			),
			Effect.asVoid,
		),
	)
const frame = (
	state: State,
	endpoint: string,
	direction: Frame["direction"],
	p: Priority,
	message: unknown,
): Frame => ({
	session: state.options.session,
	endpoint,
	direction,
	priority: p,
	message,
})
// Protocol sends are owned too: interrupting a caller cancels admission or enqueue.
const send = Effect.fnUntraced(function* (
	state: State,
	effect: Effect.Effect<void, TransportError>,
) {
	const fiber = yield* state.workers.run(
		state.workers.check.pipe(Effect.andThen(effect)),
	)
	const result = yield* Fiber.await(fiber).pipe(
		Effect.onInterrupt(() => Fiber.interrupt(fiber)),
	)
	// Group teardown interrupts this worker; callers still receive the connection cause.
	yield* state.workers.check
	yield* result
})
const cancel = Effect.fnUntraced(function* (state: State, key: RequestKey) {
	const canceled = yield* Effect.tx(
		Effect.gen(function* () {
			const table = yield* TxRef.get(state.outgoing)
			const requestState = HashMap.get(table, key)
			if (Option.isNone(requestState))
				return Option.none<RequestState<RpcMessage.FromServerEncoded>>()
			if (requestState.value.sent) {
				yield* enqueue(
					state,
					frame(state, key.endpoint, "request", "control", {
						_tag: "Interrupt",
						requestId: key.id,
					}),
				)
				return Option.none<RequestState<RpcMessage.FromServerEncoded>>()
			}
			yield* TxRef.set(state.outgoing, HashMap.remove(table, key))
			return requestState
		}),
	)
	if (Option.isSome(canceled)) yield* Queue.end(canceled.value.queue)
})
const clientProtocol = (
	state: State,
	endpoint: string,
): RpcClient.Protocol["Service"] => {
	// Accessors accept endpoints declared when the port was created.
	const client = Option.getOrThrow(HashMap.get(state.clients, endpoint))
	return RpcClient.Protocol.of({
		codecFor: RpcSerialization.json.codecFor,
		supportsAck: true,
		supportsTransferables: false,
		run: (_id, receive) =>
			Deferred.succeed(client.ready, receive).pipe(
				Effect.andThen(state.workers.await),
				Effect.catchCause((cause) =>
					receive({ _tag: "ClientProtocolError", error: rpcError(cause) }),
				),
				Effect.andThen(Effect.never),
			),
		send: (_id, message) =>
			send(
				state,
				Effect.gen(function* () {
					if (message._tag === "Request") {
						if (message.discard === true || message.isNotification === true)
							return yield* error(
								"Discard and notification requests are not supported",
							)
						const key = new RequestKey({ endpoint, id: message.id })
						const requestState = yield* mailbox<RpcMessage.FromServerEncoded>(
							priority(client.group, message.tag),
						)
						yield* admit(state, state.outgoing, key, requestState, "outgoing")
						yield* state.workers.run(
							Stream.fromQueue(requestState.queue).pipe(
								Stream.runForEach(
									Effect.fnUntraced(function* (response) {
										const receive = yield* Deferred.await(client.ready)
										if (response._tag === "Exit")
											yield* remove(state.outgoing, key, requestState)
										yield* receive(response)
									}),
								),
							),
						)
						yield* enqueue(
							state,
							frame(state, endpoint, "request", requestState.priority, message),
							Option.some(key),
						)
					} else if (message._tag === "Interrupt") {
						yield* cancel(
							state,
							new RequestKey({ endpoint, id: message.requestId }),
						)
					} else if (message._tag === "Ack") {
						yield* enqueue(
							state,
							frame(state, endpoint, "request", "control", message),
						)
					}
				}),
			).pipe(Effect.mapError((failure) => rpcError(Cause.fail(failure)))),
	})
}
const serverProtocol = (
	state: State,
	endpoint: string,
): RpcServer.Protocol["Service"] => {
	// Accessors accept endpoints declared when the port was created.
	const server = Option.getOrThrow(HashMap.get(state.servers, endpoint))
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
				state,
				Effect.gen(function* () {
					if (message._tag === "Chunk" || message._tag === "Exit") {
						const key = new RequestKey({ endpoint, id: message.requestId })
						const requestState = yield* TxRef.get(state.incoming).pipe(
							Effect.map(HashMap.get(key)),
						)
						if (Option.isNone(requestState)) return
						yield* enqueue(
							state,
							frame(
								state,
								endpoint,
								"response",
								message._tag === "Exit"
									? "control"
									: requestState.value.priority,
								message,
							),
						)
						if (message._tag === "Exit")
							yield* remove(state.incoming, key, requestState.value)
					} else
						yield* enqueue(
							state,
							frame(state, endpoint, "response", "control", message),
						)
				}),
			).pipe(
				// Disconnect already carries this cause to the server; late sends need no second failure.
				Effect.catchTag("TransportError", () => Effect.void),
			),
	})
}
const next = (state: State) =>
	Effect.tx(
		Effect.gen(function* () {
			yield* state.workers.check
			for (const p of [
				"control",
				"data",
				"log",
			] satisfies ReadonlyArray<Priority>) {
				const pending = yield* TxQueue.poll(state.queues[p])
				if (Option.isNone(pending)) continue
				const { frame, request } = pending.value
				if (Option.isSome(request)) {
					const table = yield* TxRef.get(state.outgoing)
					const requestState = HashMap.get(table, request.value)
					if (Option.isNone(requestState)) return Option.none<Frame>()
					yield* TxRef.set(
						state.outgoing,
						HashMap.set(table, request.value, {
							...requestState.value,
							sent: true,
						}),
					)
				}
				return Option.some(frame)
			}
			if (
				(yield* TxQueue.isDone(state.queues.control)) &&
				(yield* TxQueue.isDone(state.queues.data)) &&
				(yield* TxQueue.isDone(state.queues.log))
			)
				return yield* Cause.done()
			return yield* Effect.txRetry
		}),
	)
const writer = (state: State) =>
	Stream.fromEffectRepeat(next(state)).pipe(
		Stream.filterMap(Result.fromOption(() => undefined)),
		Stream.mapEffect((frame) =>
			Schema.encodeEffect(Schema.fromJsonString(Frame))(frame).pipe(
				Effect.mapError((cause) =>
					TransportError.make({ cause: Cause.fail(cause) }),
				),
			),
		),
		Stream.map((json) => new TextEncoder().encode(json + "\n")),
		Stream.run(state.bytes.output),
	)
const read = Effect.fnUntraced(function* (state: State, raw: unknown) {
	const current = yield* Schema.decodeUnknownEffect(Frame)(raw).pipe(
		Effect.mapError((cause) =>
			TransportError.make({ cause: Cause.fail(cause) }),
		),
	)
	if (current.session !== state.options.session) return
	if (current.direction === "request") {
		const server = HashMap.get(state.servers, current.endpoint)
		if (Option.isNone(server))
			return yield* error(`Unknown RPC server endpoint: ${current.endpoint}`)
		const message = yield* Schema.decodeUnknownEffect(Request)(
			current.message,
		).pipe(
			Effect.mapError((cause) =>
				TransportError.make({ cause: Cause.fail(cause) }),
			),
		)
		if (message._tag === "Eof")
			return yield* TransportError.make({
				cause: Cause.fail(EndOfStream.make({})),
			})
		const key = new RequestKey({
			endpoint: current.endpoint,
			id: message._tag === "Request" ? message.id : message.requestId,
		})
		if (message._tag === "Request") {
			const p = priority(server.value.group, message.tag)
			const requestState = yield* mailbox<RpcMessage.FromClientEncoded>(p)
			yield* admit(state, state.incoming, key, requestState, "incoming")
			yield* state.workers.run(
				Stream.fromQueue(requestState.queue).pipe(
					Stream.runForEach(
						Effect.fnUntraced(function* (request) {
							const receive = yield* Deferred.await(server.value.ready)
							yield* receive(0, request)
						}),
					),
				),
			)
			yield* deliver(requestState, message)
		} else {
			const requestState = yield* TxRef.get(state.incoming).pipe(
				Effect.map(HashMap.get(key)),
			)
			if (Option.isSome(requestState))
				yield* deliver(requestState.value, message)
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
		const requestState = yield* TxRef.get(state.outgoing).pipe(
			Effect.map(HashMap.get(key)),
		)
		if (Option.isSome(requestState)) yield* deliver(requestState.value, message)
	}
})
const reader = (state: State) =>
	state.bytes.input.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.filter((line) => line.length > 0),
		Stream.mapEffect((line) =>
			Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
				Effect.mapError((cause) =>
					TransportError.make({ cause: Cause.fail(cause) }),
				),
			),
		),
		Stream.runForEach((raw) => read(state, raw)),
		Effect.andThen(
			Effect.fail(
				TransportError.make({ cause: Cause.fail(EndOfStream.make({})) }),
			),
		),
	)

/** One RPC client/server per declared endpoint; servers may start after the port. */
export const make = Effect.fnUntraced(function* (
	bytes: Channel,
	options: Options,
): Effect.fn.Return<Port, never, import("effect").Scope.Scope> {
	const state = yield* initialize(bytes, options)
	// The same failure remains observable through Port.await and client requests.
	// This observer only publishes disconnects, even while the owner closes its scope.
	yield* state.workers.await.pipe(
		Effect.catchCause(() =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					for (const server of HashMap.values(state.servers))
						yield* Queue.offer(server.disconnects, 0)
					yield* Effect.tx(
						TxRef.set(state.incoming, HashMap.empty()).pipe(
							Effect.andThen(TxRef.set(state.outgoing, HashMap.empty())),
						),
					)
				}),
			),
		),
		Effect.forkScoped,
	)
	const writing = yield* state.workers.run(writer(state))
	yield* state.workers.run(reader(state))
	return {
		clientProtocol: (endpoint) => clientProtocol(state, endpoint),
		serverProtocol: (endpoint) => serverProtocol(state, endpoint),
		await: state.workers.await,
		fail: state.workers.fail,
		end: Effect.tx(
			Effect.forEach(Record.values(state.queues), TxQueue.end, {
				discard: true,
			}),
		).pipe(Effect.andThen(Fiber.join(writing))),
	}
})
