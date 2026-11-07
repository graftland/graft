import type { AddressInfo } from "node:net"

import {
	Cause,
	Context,
	Deferred,
	Effect,
	FiberSet,
	Queue,
	Ref,
	Schedule,
	Schema,
} from "effect"
import { Socket } from "effect/socket"

import { Graft, Plugin } from "@graftland/graft"

import { Forecast } from "@example/forecast-contract"
import { WebSocket, WebSocketServer } from "ws"

export const Frame = Schema.Struct({
	kind: Schema.String,
	id: Schema.String,
	text: Schema.String,
})
export type Frame = typeof Frame.Type
const wire = Schema.fromJsonString(Frame)
const encode = (frame: Frame) =>
	Schema.encodeEffect(wire)(frame).pipe(Effect.orDie)
const decode = Schema.decodeUnknownEffect(wire)

export class Gateway extends Context.Service<
	Gateway,
	{
		readonly messages: Queue.Queue<Frame>
		readonly send: (frame: Frame) => Effect.Effect<void, Socket.SocketError>
		readonly session: string
	}
>()("@example/gateway/gateway") {}

/** A local stand-in for a bot platform. Every connection must log in once. */
export const localBot = Effect.fnUntraced(function* () {
	const logins = yield* Ref.make(0)
	const session = yield* Ref.make("")
	const heartbeats = yield* Ref.make(0)
	const connected = yield* Deferred.make<WebSocket>()
	const responses = yield* Queue.unbounded<Frame>()
	const incoming = yield* Queue.unbounded<{ socket: WebSocket; text: string }>()
	const server = yield* Effect.acquireRelease(
		Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
		(server) =>
			Effect.callback<void>((resume) => {
				for (const socket of server.clients) socket.terminate()
				server.close((error) =>
					resume(error !== undefined ? Effect.die(error) : Effect.void),
				)
			}),
	)
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			Queue.offerUnsafe(incoming, { socket, text: data.toString() })
		})
		socket.on("error", (error) => {
			Queue.failCauseUnsafe(incoming, Cause.die(error))
		})
	})
	yield* Effect.callback<void>((resume) => {
		if (server.address() !== null) {
			resume(Effect.void)
			return
		}
		server.once("listening", () => resume(Effect.void))
		server.once("error", (error) => resume(Effect.die(error)))
	})
	const address = server.address() as AddressInfo
	const loop = Effect.forever(
		Effect.gen(function* () {
			const { socket, text } = yield* Queue.take(incoming)
			const frame = yield* decode(text)
			if (frame.kind === "login") {
				const count = yield* Ref.updateAndGet(logins, (n) => n + 1)
				yield* Ref.set(session, "session-" + count)
				yield* encode({
					kind: "session",
					id: "session-" + count,
					text: "",
				}).pipe(Effect.flatMap((text) => Effect.sync(() => socket.send(text))))
				yield* Deferred.succeed(connected, socket)
			} else if (frame.kind === "heartbeat") {
				const current = yield* Ref.get(session)
				if (frame.id !== current)
					return yield* Effect.fail("Invalid bot session")
				yield* Ref.update(heartbeats, (n) => n + 1)
				yield* encode({ kind: "heartbeat", id: frame.id, text: "" }).pipe(
					Effect.flatMap((text) => Effect.sync(() => socket.send(text))),
				)
			} else if (frame.kind === "response") yield* Queue.offer(responses, frame)
		}),
	)
	const fiber = yield* Effect.forkScoped(
		loop.pipe(Effect.tapCause(Effect.logError)),
	)
	return {
		session,
		logins,
		heartbeats,
		responses,
		fiber,
		url: "ws://127.0.0.1:" + address.port,
		message: (id: string, text: string) =>
			Deferred.await(connected).pipe(
				Effect.flatMap((socket) =>
					encode({ kind: "message", id, text }).pipe(
						Effect.flatMap((encoded) =>
							Effect.sync(() => socket.send(encoded)),
						),
					),
				),
			),
	}
})

export const gateway = (url: string, activations: Ref.Ref<number>) =>
	Plugin.make({
		name: "@example/gateway",
		apply: Effect.fnUntraced(function* () {
			yield* Ref.update(activations, (n) => n + 1)
			const session = yield* Deferred.make<string>()
			const messages = yield* Queue.unbounded<Frame>()
			const socket = yield* Socket.makeWebSocket(url).pipe(
				Effect.provideService(
					Socket.WebSocketConstructor,
					(url) => new WebSocket(url),
				),
			)
			const write = yield* socket.writer
			const send = (frame: Frame) =>
				encode(frame).pipe(Effect.flatMap(write.write))
			const reader = yield* socket.reader
			yield* send({ kind: "login", id: "", text: "local-bot" })
			const decoder = new TextDecoder()
			yield* Plugin.fork(
				Effect.forever(
					reader.pull.pipe(
						Effect.flatMap((frames) =>
							Effect.forEach(
								frames,
								(frame) =>
									decode(
										typeof frame === "string" ? frame : decoder.decode(frame),
									).pipe(
										Effect.flatMap((message) =>
											message.kind === "session"
												? Deferred.succeed(session, message.id)
												: message.kind === "message"
													? Queue.offer(messages, message)
													: Effect.void,
										),
									),
								{ discard: true },
							),
						),
					),
				),
			)

			const id = yield* Deferred.await(session)
			yield* Plugin.fork(
				send({ kind: "heartbeat", id, text: "" }).pipe(
					Effect.repeat(Schedule.spaced("100 millis")),
				),
			)
			yield* Graft.provide(Gateway, { session: id, messages, send })
		}),
	})

export const consume = (
	activations: Ref.Ref<number>,
	session: Deferred.Deferred<string>,
) =>
	Plugin.make({
		name: "@example/commands",
		inject: [Gateway, Forecast],
		apply: Effect.fnUntraced(function* () {
			yield* Ref.update(activations, (n) => n + 1)
			const upstream = yield* Gateway
			const forecast = yield* Forecast
			yield* Deferred.succeed(session, upstream.session)
			const calls = yield* FiberSet.make<void, Socket.SocketError>()
			yield* Plugin.fork(
				Effect.forever(
					Effect.gen(function* () {
						const frame = yield* Queue.take(upstream.messages)
						yield* FiberSet.run(
							calls,
							forecast.get(frame.text).pipe(
								Effect.catchCause((cause) =>
									Effect.logError(cause).pipe(
										Effect.as("Forecast unavailable"),
									),
								),
								Effect.flatMap((text) =>
									upstream.send({ kind: "response", id: frame.id, text }),
								),
							),
						)
					}),
				),
			)
			yield* Plugin.fork(FiberSet.join(calls))
		}),
	})
