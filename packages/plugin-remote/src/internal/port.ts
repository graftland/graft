import {
	Array,
	Bytes,
	Cause,
	Chunk,
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	Queue,
	Record,
	Ref,
	Result,
	Schema,
	Stream,
	String,
	TxQueue,
	TxRef,
	type Scope,
} from "effect"
import {
	RpcClient,
	RpcClientError,
	RpcSerialization,
	RpcServer,
	type Rpc,
	type RpcGroup,
	type RpcMessage,
} from "effect/rpc"

import { TransportError } from "../Errors"
import type { Channel } from "../Transport"
import * as FailureGroup from "./FailureGroup"
import { defaults, type Limits } from "./Limits"
import { EndOfStream, maxPayload } from "./runner/Framing"

export type { Channel } from "../Transport"

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
	readonly logAck: Ref.Ref<Option.Option<Deferred.Deferred<void>>> | undefined
}
const Frame = Schema.Struct({
	session: Schema.String,
	endpoint: Schema.String,
	direction: Schema.Literals(["request", "response"]),
	priority: Schema.Literals(["control", "data", "log"]),
	message: Schema.Unknown,
})
type Frame = typeof Frame.Type
// Compile these codecs once; constructing fromJsonString per frame rebuilds its AST.
const encodeFrame = Schema.encodeEffect(Schema.fromJsonString(Frame))
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))
const decodeFrame = Schema.decodeUnknownEffect(Frame)
const textEncoder = new TextEncoder()
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
// A singleton array preserves JSON's array-element handling of undefined values.
const encodeLogValue = (value: unknown) =>
	encodeJson([value]).pipe(
		Effect.map((json) => textEncoder.encode(String.slice(1, -1)(json))),
	)
const logSuffix = textEncoder.encode("]}}\n")
const logSeparator = textEncoder.encode(",")
interface LogCursor {
	readonly index: number
	readonly pending: Uint8Array | undefined
}
// RPC has already schema-encoded these values. Serialize each record once and
// carry the first non-fitting record into the next batch without re-encoding it.
const logBatches = (current: Frame, message: RpcMessage.ResponseChunkEncoded) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const closing = "]}}"
			const envelope = yield* encodeFrame({
				...current,
				message: { _tag: "Chunk", requestId: message.requestId, values: [] },
			})
			const prefix = textEncoder.encode(
				String.slice(0, -closing.length)(envelope),
			)
			const finish = (
				parts: Chunk.Chunk<Uint8Array>,
				cursor: LogCursor,
			): readonly [Uint8Array, LogCursor] => [
				Bytes.concat([
					prefix,
					...Array.intersperse(Chunk.toArray(parts), logSeparator),
					logSuffix,
				]),
				cursor,
			]
			const fill = Effect.fnUntraced(function* (
				cursor: LogCursor,
				parts: Chunk.Chunk<Uint8Array>,
				length: number,
			): Effect.fn.Return<
				readonly [Uint8Array, LogCursor] | undefined,
				Schema.SchemaError
			> {
				if (cursor.index === message.values.length)
					return Chunk.isEmpty(parts) ? undefined : finish(parts, cursor)
				const bytes =
					cursor.pending ??
					(yield* encodeLogValue(message.values[cursor.index]))
				const size =
					length +
					bytes.byteLength +
					(Chunk.isEmpty(parts) ? 0 : logSeparator.byteLength)
				if (!Chunk.isEmpty(parts) && size > maxPayload)
					return finish(parts, { index: cursor.index, pending: bytes })
				const next = { index: cursor.index + 1, pending: undefined }
				const appended = Chunk.append(parts, bytes)
				// An oversized single record keeps the existing transport behavior.
				if (size >= maxPayload) return finish(appended, next)
				return yield* fill(next, appended, size)
			})
			return Stream.unfold<LogCursor, Uint8Array, Schema.SchemaError, never>(
				{ index: 0, pending: undefined },
				(cursor) =>
					fill(cursor, Chunk.empty(), prefix.byteLength + logSuffix.byteLength),
			)
		}),
	).pipe(
		Stream.mapError((cause) =>
			TransportError.make({ cause: Cause.fail(cause) }),
		),
	)
interface Pending {
	readonly frame: Frame
	readonly request: Option.Option<RequestKey>
	readonly encoded: Uint8Array | undefined
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
const decodeRequest = Schema.decodeUnknownEffect(Request)
const decodeResponse = Schema.decodeUnknownEffect(Response)
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
const mailbox = Effect.fnUntraced(function* <A>(
	priority: Priority,
): Effect.fn.Return<RequestState<A>> {
	const queue = yield* Queue.dropping<A, Cause.Done>(2)
	const logAck =
		priority === "log"
			? yield* Ref.make(Option.none<Deferred.Deferred<void>>())
			: undefined
	return { queue, priority, sent: false, logAck }
})

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
	readonly admission: Record<Priority, Queue.Queue<void, TransportError>>
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
const initialize = Effect.fnUntraced(function* (
	bytes: Channel,
	options: Options,
): Effect.fn.Return<State, never, Scope.Scope> {
	const limits = { ...defaults, ...options.limits }
	const workers = yield* FailureGroup.make<TransportError>()
	const permits = Effect.fnUntraced(function* (limit: number) {
		const queue = yield* Queue.bounded<void, TransportError>(limit)
		yield* Queue.offerAll(
			queue,
			Array.makeBy(limit, () => undefined),
		)
		return queue
	})
	const admission = {
		control: yield* permits(limits.control),
		data: yield* permits(limits.data),
		log: yield* permits(limits.log),
	}
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
		admission,
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
	if (direction === "outgoing")
		return yield* Effect.tx(
			state.workers.check.pipe(
				Effect.andThen(TxRef.update(table, HashMap.set(key, requestState))),
			),
		)
	yield* Effect.tx(
		Effect.gen(function* () {
			yield* state.workers.check
			const current = yield* TxRef.get(table)
			const count = Array.reduce(
				HashMap.values(current),
				0,
				(count, entry) =>
					count + (entry.priority === requestState.priority ? 1 : 0),
			)
			if (count >= state.limits[requestState.priority])
				return yield* error(
					`RPC admission limit exceeded for ${requestState.priority}`,
				)
			yield* TxRef.set(table, HashMap.set(current, key, requestState))
		}),
	)
})
const remove = Effect.fnUntraced(function* <A>(
	table: TxRef.TxRef<HashMap.HashMap<RequestKey, RequestState<A>>>,
	key: RequestKey,
	requestState: RequestState<A>,
) {
	// The sent flag replaces the wrapper; the mailbox is this request's stable identity.
	yield* TxRef.update(table, (current) =>
		Option.exists(
			HashMap.get(current, key),
			(entry) => entry.queue === requestState.queue,
		)
			? HashMap.remove(current, key)
			: current,
	)
	yield* Queue.end(requestState.queue)
}, Effect.uninterruptible)
const enqueue = (
	state: State,
	frame: Frame,
	request: Option.Option<RequestKey> = Option.none(),
	encoded?: Uint8Array,
) =>
	Effect.tx(
		state.workers.check.pipe(
			Effect.andThen(
				TxQueue.offer(state.queues[frame.priority], {
					frame,
					request,
					encoded,
				}).pipe(
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
// The caller owns each protocol send; request workers own admission and response lifetimes.
const send = (state: State, effect: Effect.Effect<void, TransportError>) =>
	state.workers.check.pipe(
		Effect.andThen(effect),
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: state.workers.failCause(cause),
		),
		Effect.andThen(state.workers.check),
	)

const cancel = Effect.fnUntraced(function* (state: State, key: RequestKey) {
	const canceled = yield* Effect.tx(
		Effect.gen(function* () {
			const table = yield* TxRef.get(state.outgoing)
			const requestState = HashMap.get(table, key)
			if (Option.isNone(requestState))
				return {
					interrupt: true,
					retired: Option.none<RequestState<RpcMessage.FromServerEncoded>>(),
				}
			if (requestState.value.sent) {
				yield* enqueue(
					state,
					frame(state, key.endpoint, "request", "control", {
						_tag: "Interrupt",
						requestId: key.id,
					}),
				)
				// Keep the admitted worker and its permit until the peer's terminal Exit.
				return {
					interrupt: false,
					retired: Option.none<RequestState<RpcMessage.FromServerEncoded>>(),
				}
			}
			yield* TxRef.set(state.outgoing, HashMap.remove(table, key))
			return { interrupt: true, retired: requestState }
		}),
	)
	if (Option.isSome(canceled.retired))
		yield* Queue.end(canceled.retired.value.queue)
	return canceled.interrupt
}, Effect.uninterruptible)

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
						yield* Effect.uninterruptibleMask((restore) =>
							Effect.gen(function* () {
								const p = priority(client.group, message.tag)
								const permits = state.admission[p]
								// The caller owns this interruptible wait. No mailbox or worker exists
								// until admission, and disconnect fails the queue with the full cause.
								yield* restore(Queue.take(permits))
								const held = yield* Ref.make(true)
								const release = Ref.getAndSet(held, false).pipe(
									Effect.flatMap((held) =>
										held
											? Effect.sync(() => {
													// Returning a permit must wake its next caller in this turn,
													// rather than scheduling another queue-release task.
													Queue.offerUnsafe(permits, undefined)
													Queue.flushUnsafe(permits)
												})
											: Effect.void,
									),
									Effect.uninterruptible,
								)
								const key = new RequestKey({ endpoint, id: message.id })
								const requestState =
									yield* mailbox<RpcMessage.FromServerEncoded>(p)
								const prepared = yield* Effect.exit(
									admit(state, state.outgoing, key, requestState, "outgoing"),
								)
								if (Exit.isFailure(prepared)) {
									yield* remove(state.outgoing, key, requestState)
									yield* release
									return yield* prepared
								}
								// Transfer the permit to the existing owned response worker without
								// an interruptible gap. Cancellation retains it until the peer's Exit.
								yield* state.workers.run(
									Stream.fromQueue(requestState.queue).pipe(
										Stream.runForEach(
											Effect.fnUntraced(function* (response) {
												const receive = yield* Deferred.await(client.ready)
												if (response._tag === "Exit") {
													yield* remove(state.outgoing, key, requestState)
													// The peer has finished. Local result delivery must not hold its slot.
													yield* release
												}
												yield* receive(response)
											}),
										),
										Effect.ensuring(remove(state.outgoing, key, requestState)),
										Effect.ensuring(release),
									),
									{ startImmediately: true },
								)
								yield* enqueue(
									state,
									frame(state, endpoint, "request", p, message),
									Option.some(key),
								)
								yield* state.workers.check
							}),
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
						const current = frame(
							state,
							endpoint,
							"response",
							message._tag === "Exit" ? "control" : requestState.value.priority,
							message,
						)
						const logAck = requestState.value.logAck
						if (message._tag === "Chunk" && logAck !== undefined) {
							yield* state.workers.race(
								logBatches(current, message).pipe(
									Stream.runForEach((bytes) =>
										Effect.gen(function* () {
											const ack = yield* Deferred.make<void>()
											yield* Ref.set(logAck, Option.some(ack))
											yield* enqueue(state, current, Option.none(), bytes)
											yield* Deferred.await(ack)
										}).pipe(Effect.ensuring(Ref.set(logAck, Option.none()))),
									),
								),
							)
							// Each bounded part is acknowledged; RPC still sees one ACK for its original chunk.
							yield* deliver(requestState.value, {
								_tag: "Ack",
								requestId: message.requestId,
							})
						} else yield* enqueue(state, current)
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
const next = Effect.fnUntraced(function* (state: State) {
	yield* state.workers.check
	for (const p of [
		"control",
		"data",
		"log",
	] satisfies ReadonlyArray<Priority>) {
		const pending = yield* TxQueue.poll(state.queues[p])
		if (Option.isNone(pending)) continue
		const { request } = pending.value
		if (Option.isSome(request)) {
			const table = yield* TxRef.get(state.outgoing)
			const requestState = HashMap.get(table, request.value)
			if (Option.isNone(requestState)) return Option.none<Pending>()
			yield* TxRef.set(
				state.outgoing,
				HashMap.set(table, request.value, {
					...requestState.value,
					sent: true,
				}),
			)
		}
		return Option.some(pending.value)
	}
	if (
		(yield* TxQueue.isDone(state.queues.control)) &&
		(yield* TxQueue.isDone(state.queues.data)) &&
		(yield* TxQueue.isDone(state.queues.log))
	)
		return yield* Cause.done()
	return yield* Effect.txRetry
}, Effect.tx)
const writer = (state: State) =>
	Stream.fromEffectRepeat(next(state)).pipe(
		Stream.filterMap(Result.fromOption(() => undefined)),
		Stream.mapEffect((pending) =>
			pending.encoded === undefined
				? encodeFrame(pending.frame).pipe(
						Effect.mapBoth({
							onSuccess: (json) => textEncoder.encode(json + "\n"),
							onFailure: (cause) =>
								TransportError.make({ cause: Cause.fail(cause) }),
						}),
					)
				: Effect.succeed(pending.encoded),
		),
		Stream.run(state.bytes.output),
	)

const read = Effect.fnUntraced(function* (state: State, raw: unknown) {
	const current = yield* decodeFrame(raw).pipe(
		Effect.mapError((cause) =>
			TransportError.make({ cause: Cause.fail(cause) }),
		),
	)
	if (current.session !== state.options.session) return
	if (current.direction === "request") {
		const server = HashMap.get(state.servers, current.endpoint)
		if (Option.isNone(server))
			return yield* error(`Unknown RPC server endpoint: ${current.endpoint}`)
		const message = yield* decodeRequest(current.message).pipe(
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
			if (Option.isSome(requestState)) {
				const logAck = requestState.value.logAck
				const ack =
					message._tag === "Ack" && logAck !== undefined
						? yield* Ref.getAndSet(logAck, Option.none())
						: Option.none<Deferred.Deferred<void>>()
				if (Option.isSome(ack)) yield* Deferred.succeed(ack.value, undefined)
				else yield* deliver(requestState.value, message)
			}
		}
	} else {
		const message = yield* decodeResponse(current.message).pipe(
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
			decodeJson(line).pipe(
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
		Effect.catchCause(
			Effect.fnUntraced(function* (cause) {
				for (const permits of Record.values(state.admission))
					yield* Queue.failCause(permits, cause)
				for (const server of HashMap.values(state.servers))
					yield* Queue.offer(server.disconnects, 0)
				yield* Effect.tx(
					TxRef.set(state.incoming, HashMap.empty()).pipe(
						Effect.andThen(TxRef.set(state.outgoing, HashMap.empty())),
					),
				)
			}, Effect.uninterruptible),
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
