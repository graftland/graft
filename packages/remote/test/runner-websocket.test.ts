import { Peer } from "../src/Auth"
import { identityFromSubjectAltName } from "../src/internal/auth/mtls"
import { assert, describe, it } from "@effect/vitest"
import { NodeServices, NodeSocket } from "@effect/platform-node"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Redacted,
} from "effect"
import { inject, expectTypeOf } from "vitest"
import { Socket } from "effect/socket"
import WS from "ws"
import * as Remote from "../src/index"
import * as WebsocketClient from "../src/internal/websocket"
import * as Websocket from "./websocket"
import * as Framing from "../src/internal/runner/Framing"

declare module "vitest" {
	export interface ProvidedContext {
		remoteTls: string
	}
}
const credentials = (name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const root = inject("remoteTls")
		const key = yield* fs.readFileString(`${root}/${name}.key`)
		return {
			key: Redacted.make(key),
			cert: yield* fs.readFileString(`${root}/${name}.crt`),
			ca: yield* fs.readFileString(`${root}/ca.crt`),
		}
	})
const bytes = (value: string) => new TextEncoder().encode(value)
const text = (value: Uint8Array) => new TextDecoder().decode(value)
const server = Effect.gen(function* () {
	const listener = yield* Websocket.listen({
		host: "127.0.0.1",
		port: 0,
		tls: yield* credentials("server"),
	})
	assert.equal(listener.address._tag, "InetAddressV4")
	if (listener.address._tag !== "InetAddressV4")
		return yield* Effect.die(new Error("Expected a TCP listener"))
	return { listener, port: listener.address.port }
})

const httpResponse = (
	port: number,
	tls: Websocket.Credentials,
	path: string,
	protocol?: string,
) =>
	Effect.gen(function* () {
		const socket = yield* NodeSocket.makeTls({
			host: "127.0.0.1",
			port,
			servername: "localhost",
			ca: tls.ca,
			cert: tls.cert,
			key: Redacted.value(tls.key),
			rejectUnauthorized: true,
		})
		const reader = yield* socket.reader
		const writer = yield* socket.writer
		yield* writer.write(
			`GET ${path} HTTP/1.1\r\nHost: localhost\r\n` +
				(protocol === undefined
					? "Connection: close\r\n"
					: `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: ${protocol}\r\n`) +
				"\r\n",
		)
		const response = yield* reader.pull
		return Array.join(
			Array.map(response, (value) =>
				typeof value === "string" ? value : text(value),
			),
			"",
		)
	}).pipe(Effect.scoped)

describe("runner WebSocket mutual TLS", () => {
	it("excludes literal ws targets from the mTLS runner API", () => {
		expectTypeOf<
			Parameters<
				typeof Remote.runner<"ws://localhost", readonly []>
			>[0]["transport"]
		>().toEqualTypeOf<never>()
	})

	it.live("rejects a plain TLS HTTP request without a WebSocket upgrade", () =>
		Effect.gen(function* () {
			const { listener, port } = yield* server
			yield* listener.run(() => Effect.never).pipe(Effect.forkScoped)
			const tls = yield* credentials("client")
			const response = yield* httpResponse(port, tls, "/graft")
			assert.include(response, "HTTP/1.1 400")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("rejects a WebSocket handshake without a client certificate", () =>
		Effect.gen(function* () {
			const { listener, port } = yield* server
			yield* listener.run(() => Effect.never).pipe(Effect.forkScoped)
			const tls = yield* credentials("client")
			const socket = yield* Socket.makeWebSocket(
				`wss://127.0.0.1:${port}/graft`,
				{
					protocols: "graft-remote.v1",
				},
			).pipe(
				Effect.provideService(
					Socket.WebSocketConstructor,
					(url) =>
						new WS(url, "graft-remote.v1", {
							ca: tls.ca,
						}),
				),
			)
			const rejected = yield* Effect.exit(socket.reader)
			assert.isTrue(Exit.isFailure(rejected))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live(
		"returns 404 for another path and 400 for another subprotocol before upgrade",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				yield* listener.run(() => Effect.never).pipe(Effect.forkScoped)
				const tls = yield* credentials("client")
				// Both errors are HTTP responses, before ws sends a 101 Switching Protocols.
				const path = yield* httpResponse(port, tls, "/other", "graft-remote.v1")
				const protocol = yield* httpResponse(port, tls, "/graft", "other")
				assert.include(path, "HTTP/1.1 404")
				assert.include(protocol, "HTTP/1.1 400")
				assert.notInclude(path + protocol, "101 Switching Protocols")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("rejects text messages and continues serving the next host", () =>
		Effect.gen(function* () {
			const { listener, port } = yield* server
			const rejected = yield* Deferred.make<string>()
			yield* listener
				.run((socket) =>
					Effect.gen(function* () {
						const peer = yield* Websocket.multiplex(socket)
						yield* peer.take(0).pipe(
							Effect.flatMap((payload) => peer.send(0, payload)),
							Effect.tapCause((cause) =>
								Deferred.succeed(rejected, Cause.pretty(cause)),
							),
						)
						return yield* peer.await
					}),
				)
				.pipe(Effect.forkScoped)
			const tls = yield* credentials("client")
			yield* Effect.gen(function* () {
				const socket = yield* Websocket.connect({
					port,
					tls,
					servername: "localhost",
				})
				const reader = yield* socket.reader
				const writer = yield* socket.writer
				yield* writer.write("not a binary frame")
				const ended = yield* Effect.exit(reader.pull)
				assert.isTrue(Exit.isFailure(ended))
			}).pipe(Effect.scoped)
			const reason = yield* Deferred.await(rejected)
			assert.include(reason, "messages must be binary")
			const socket = yield* Websocket.connect({
				port,
				tls,
				servername: "localhost",
			})
			const peer = yield* Websocket.multiplex(socket)
			yield* peer.send(0, bytes("next host"))
			const reply = yield* peer.take(0)
			assert.equal(text(reply), "next host")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("rejects an environment URL using ws before dialing", () =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(
				WebsocketClient.connect(
					{
						url: String("ws://localhost"),
						tls: { ca: "unused" },
					},
					{ cert: "unused", key: Redacted.make("unused") },
				),
			)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				assert.isFalse(Cause.hasDies(result.cause))
				assert.include(Cause.pretty(result.cause), "wss://")
			}
		}).pipe(Effect.scoped),
	)

	it.effect("reads the unique graft URI from a dedicated CA certificate", () =>
		Effect.gen(function* () {
			const valid = yield* identityFromSubjectAltName(
				"DNS:localhost, URI:graft://real",
			)
			assert.equal(valid, "graft://real")
			for (const san of [
				undefined,
				"DNS:localhost",
				"URI:graft://one, URI:graft://two",
			]) {
				const result = yield* Effect.exit(identityFromSubjectAltName(san))
				assert.isTrue(Exit.isFailure(result), String(san))
			}
		}),
	)

	it.live(
		"authenticates certificate identity and carries opaque instance and session frames",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				const identity = yield* Deferred.make<string>()
				yield* listener
					.run((socket) =>
						Effect.gen(function* () {
							const authenticated = yield* Peer
							yield* Deferred.succeed(identity, authenticated)
							const peer = yield* Websocket.multiplex(socket)
							const input = yield* peer.take(1)
							yield* peer.send(1, input)
							yield* peer.send(0, bytes("session"))
							return yield* Effect.never
						}),
					)
					.pipe(Effect.forkScoped)
				const socket = yield* Websocket.connect({
					port,
					servername: "localhost",
					tls: yield* credentials("client"),
				})
				const peer = yield* Websocket.multiplex(socket)
				yield* peer.send(1, new Uint8Array([255, 0, 1]))
				const echoed = yield* peer.take(1)
				const session = yield* peer.take(0)
				const authenticated = yield* Deferred.await(identity)
				assert.deepEqual(echoed, new Uint8Array([255, 0, 1]))
				assert.equal(text(session), "session")
				assert.equal(authenticated, "graft://test-host")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
	it.live(
		"rejects unauthenticated clients and missing or ambiguous SAN identities without disabling the listener",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				const accepted = yield* Deferred.make<void>()
				yield* listener
					.run((socket) =>
						Effect.gen(function* () {
							yield* Deferred.succeed(accepted, undefined)
							const peer = yield* Websocket.multiplex(socket)
							yield* peer.send(0, bytes("accepted"))
							return yield* Effect.never
						}),
					)
					.pipe(Effect.forkScoped)
				const tls = yield* credentials("client")
				const unauthenticated = yield* Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const socket = yield* NodeSocket.makeTls({
								host: "127.0.0.1",
								port,
								servername: "localhost",
								ca: tls.ca,
								rejectUnauthorized: true,
							})
							const reader = yield* socket.reader
							return yield* reader.pull
						}),
					),
				)
				assert.isTrue(Exit.isFailure(unauthenticated))
				const untrusted = yield* Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const socket = yield* Websocket.connect({
								port,
								servername: "localhost",
								tls: yield* credentials("rogue"),
							})
							const reader = yield* socket.reader
							return yield* reader.pull
						}),
					),
				)
				assert.isTrue(Exit.isFailure(untrusted))
				for (const name of ["missing", "ambiguous"]) {
					const rejected = yield* Effect.exit(
						Effect.scoped(
							Effect.gen(function* () {
								const socket = yield* Websocket.connect({
									port,
									servername: "localhost",
									tls: yield* credentials(name),
								})
								const reader = yield* socket.reader
								return yield* reader.pull
							}),
						),
					)
					assert.isTrue(Exit.isFailure(rejected))
				}
				const prematurelyAccepted = yield* Deferred.isDone(accepted)
				assert.isFalse(prematurelyAccepted)
				const socket = yield* Websocket.connect({
					port,
					servername: "localhost",
					tls,
				})
				const peer = yield* Websocket.multiplex(socket)
				const response = yield* peer.take(0)
				assert.equal(text(response), "accepted")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
	it.live(
		"rejects a server name mismatch before admitting a frame",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				yield* listener.run(() => Effect.never).pipe(Effect.forkScoped)
				const socket = yield* Websocket.connect({
					port,
					servername: "incorrect.example",
					tls: yield* credentials("client"),
				})
				const opened = yield* Effect.exit(socket.reader)
				assert.isTrue(Exit.isFailure(opened))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
	it.live(
		"rejects an oversized frame header without waiting for its payload",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				const rejected = yield* Deferred.make<string>()
				yield* listener
					.run((socket) =>
						Effect.gen(function* () {
							const peer = yield* Websocket.multiplex(socket)
							const failure = yield* Effect.flip(peer.await)
							yield* Deferred.succeed(rejected, Cause.pretty(failure.cause))
						}),
					)
					.pipe(Effect.forkScoped)
				const socket = yield* Websocket.connect({
					port,
					servername: "localhost",
					tls: yield* credentials("client"),
				})
				yield* socket.reader
				const writer = yield* socket.writer
				const header = new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0])
				new DataView(header.buffer).setUint32(4, Framing.maxPayload + 1)
				yield* writer.write(header)
				const reason = yield* Deferred.await(rejected)
				assert.include(reason, "payload length")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
	it.live(
		"keeps the same namespace across certificate rotation with the same SAN URI",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				yield* listener
					.run((socket) =>
						Effect.gen(function* () {
							const identity = yield* Peer
							const peer = yield* Websocket.multiplex(socket)
							yield* peer.send(0, bytes(identity))
							return yield* Effect.never
						}),
					)
					.pipe(Effect.forkScoped)
				const identities = yield* Effect.forEach(["client", "other"], (name) =>
					Effect.scoped(
						Effect.gen(function* () {
							const socket = yield* Websocket.connect({
								port,
								servername: "localhost",
								tls: yield* credentials(name),
							})
							const peer = yield* Websocket.multiplex(socket)
							const identity = yield* peer.take(0)
							return text(identity)
						}),
					),
				)
				assert.deepEqual(identities, ["graft://test-host", "graft://test-host"])
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
})
