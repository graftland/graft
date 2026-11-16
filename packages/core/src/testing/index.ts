/**
 * An in-memory pair of `effect/rpc` protocols.
 *
 * Messages travel through the normal encode/decode path but never become
 * bytes, so tests can exercise RPC wiring without sockets, HTTP, or workers.
 * The connection can also be ended on demand, and the client can connect
 * again, which makes reconnection behavior testable.
 */
import { Effect, HashMap, Layer, Option, Queue, Ref, type Scope } from "effect"
import {
	RpcClient,
	RpcClientError,
	RpcSerialization,
	RpcServer,
	type RpcMessage,
} from "effect/rpc"

/** Writes one encoded server response to one client. */
interface Connection {
	readonly write: (message: RpcMessage.FromServerEncoded) => Effect.Effect<void>
}

/** A pair of in-memory protocols and a way to end the current connection. */
export interface InMemoryProtocol {
	/** The server side, provided to a server runtime. */
	readonly server: Layer.Layer<RpcServer.Protocol>
	/**
	 * The client side of a new connection. Each run of this effect, such as
	 * each reconnect attempt, opens an independent connection.
	 */
	readonly client: Effect.Effect<
		RpcClient.Protocol["Service"],
		never,
		Scope.Scope
	>
	/**
	 * Ends the current connection. Calls in flight on the client fail, and the
	 * next run of `client` opens a fresh connection.
	 */
	readonly disconnect: Effect.Effect<void>
}

/** Creates an in-memory server/client protocol pair. */
export const make: Effect.Effect<InMemoryProtocol, never, Scope.Scope> =
	Effect.gen(function* () {
		const disconnects = yield* Queue.make<number>()
		const inbound =
			yield* Queue.make<readonly [number, RpcMessage.FromClientEncoded]>()
		const connections = yield* Ref.make(HashMap.empty<number, Connection>())
		const current = yield* Ref.make(Option.none<number>())
		const lastId = yield* Ref.make(0)
		const codecFor = RpcSerialization.json.codecFor

		const closed = RpcClientError.RpcClientError.make({
			reason: RpcClientError.RpcClientDefect.make({
				message: "The in-memory connection was closed",
				cause: new Error("The in-memory connection was closed"),
			}),
		})

		/** Removes a connection and returns it, if it was still open. */
		const remove = Effect.fnUntraced(function* (id: number) {
			const open = yield* Ref.get(connections)
			const connection = Option.getOrUndefined(HashMap.get(open, id))
			if (connection === undefined) return undefined
			yield* Ref.update(connections, HashMap.remove(id))
			yield* Ref.update(current, (value) =>
				Option.isSome(value) && value.value === id ? Option.none() : value,
			)
			return connection
		})

		/** Closes a connection and tells the server that the client is gone. */
		const close = Effect.fnUntraced(function* (id: number) {
			const connection = yield* remove(id)
			if (connection === undefined) return
			yield* Queue.offer(disconnects, id)
		})

		const disconnect = Effect.gen(function* () {
			const id = yield* Ref.get(current)
			if (Option.isNone(id)) return
			const connection = yield* remove(id.value)
			if (connection === undefined) return
			// Let in-flight calls fail before the server interrupts them.
			yield* connection.write({ _tag: "ClientProtocolError", error: closed })
			yield* Queue.offer(disconnects, id.value)
		})

		const serverProtocol = RpcServer.Protocol.of({
			run: (f) =>
				Effect.forever(
					Effect.flatMap(Queue.take(inbound), ([clientId, message]) =>
						f(clientId, message),
					),
				),
			disconnects,
			send: (clientId, response) =>
				Effect.flatMap(Ref.get(connections), (open) =>
					Option.match(HashMap.get(open, clientId), {
						onNone: () => Effect.void,
						onSome: (connection) => connection.write(response),
					}),
				),
			// A server-side end means the client is done sending, not that the
			// connection failed, so it is not reported as a disconnect.
			end: (clientId) => Effect.asVoid(remove(clientId)),
			clientIds: Effect.map(
				Ref.get(connections),
				(open) => new Set(HashMap.keys(open)),
			),
			initialMessage: Effect.succeedNone,
			supportsAck: false,
			supportsTransferables: false,
			supportsSpanPropagation: false,
			supportsNotifications: true,
			codecFor,
		})

		const client: Effect.Effect<
			RpcClient.Protocol["Service"],
			never,
			Scope.Scope
		> = Effect.gen(function* () {
			const id = yield* Ref.modify(lastId, (last) => [last + 1, last + 1])
			const inbox = yield* Queue.make<RpcMessage.FromServerEncoded>()
			yield* Ref.update(
				connections,
				HashMap.set(id, {
					write: (message) => Effect.asVoid(Queue.offer(inbox, message)),
				}),
			)
			yield* Ref.set(current, Option.some(id))
			yield* Effect.addFinalizer(() => close(id))
			return RpcClient.Protocol.of({
				run: (_clientId, f) =>
					Effect.forever(
						Effect.flatMap(Queue.take(inbox), (message) => f(message)),
					),
				send: (_clientId, request) =>
					Effect.flatMap(Ref.get(connections), (open) =>
						HashMap.has(open, id)
							? Effect.asVoid(Queue.offer(inbound, [id, request] as const))
							: Effect.fail(closed),
					),
				supportsAck: false,
				supportsTransferables: false,
				codecFor,
			})
		})

		return {
			server: Layer.succeed(RpcServer.Protocol)(serverProtocol),
			client,
			disconnect,
		}
	})
