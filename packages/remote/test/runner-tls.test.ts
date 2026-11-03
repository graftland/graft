import { assert, describe, it } from "@effect/vitest"
import { NodeServices, NodeSocket } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, FileSystem, Redacted } from "effect"
import { inject } from "vitest"
import * as Tls from "../src/internal/runner/Tls"
import * as Multiplex from "../src/internal/runner/Multiplex"
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
	const listener = yield* Tls.listen({
		host: "127.0.0.1",
		port: 0,
		tls: yield* credentials("server"),
	})
	assert.equal(listener.address._tag, "InetAddressV4")
	if (listener.address._tag !== "InetAddressV4")
		return yield* Effect.die(new Error("Expected a TCP listener"))
	return { listener, port: listener.address.port }
})

describe("runner mutual TLS", () => {
	it.live(
		"authenticates certificate identity and carries opaque instance and session frames",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				const identity = yield* Deferred.make<string>()
				yield* listener
					.run((socket) =>
						Effect.gen(function* () {
							const authenticated = yield* Tls.Peer
							yield* Deferred.succeed(identity, authenticated)
							const peer = yield* Multiplex.fromSocket(socket)
							const input = yield* peer.take(1, 1)
							yield* peer.send(1, 1, input)
							yield* peer.send(0, 0, bytes("session"))
							return yield* Effect.never
						}),
					)
					.pipe(Effect.forkScoped)
				const socket = yield* Tls.connect({
					host: "127.0.0.1",
					port,
					servername: "localhost",
					tls: yield* credentials("client"),
				})
				const peer = yield* Multiplex.fromSocket(socket)
				yield* peer.send(1, 1, new Uint8Array([255, 0, 1]))
				const echoed = yield* peer.take(1, 1)
				const session = yield* peer.take(0, 0)
				const authenticated = yield* Deferred.await(identity)
				assert.deepEqual(echoed, new Uint8Array([255, 0, 1]))
				assert.equal(text(session), "session")
				assert.match(authenticated, /^sha256:[a-f0-9]{64}$/)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
	it.live(
		"rejects missing or untrusted client certificates and keeps the listener usable",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				const accepted = yield* Deferred.make<void>()
				yield* listener
					.run((socket) =>
						Effect.gen(function* () {
							yield* Deferred.succeed(accepted, undefined)
							const peer = yield* Multiplex.fromSocket(socket)
							yield* peer.send(0, 0, bytes("accepted"))
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
							const socket = yield* Tls.connect({
								host: "127.0.0.1",
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
				const prematurelyAccepted = yield* Deferred.isDone(accepted)
				assert.isFalse(prematurelyAccepted)
				const socket = yield* Tls.connect({
					host: "127.0.0.1",
					port,
					servername: "localhost",
					tls,
				})
				const peer = yield* Multiplex.fromSocket(socket)
				const response = yield* peer.take(0, 0)
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
				const socket = yield* Tls.connect({
					host: "127.0.0.1",
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
							const peer = yield* Multiplex.fromSocket(socket)
							const failure = yield* Effect.flip(Deferred.await(peer.failed))
							yield* Deferred.succeed(rejected, Cause.pretty(failure.cause))
						}),
					)
					.pipe(Effect.forkScoped)
				const socket = yield* Tls.connect({
					host: "127.0.0.1",
					port,
					servername: "localhost",
					tls: yield* credentials("client"),
				})
				yield* socket.reader
				const writer = yield* socket.writer
				const header = new Uint8Array([1, 1, 2, 0, 0, 0, 0, 0])
				new DataView(header.buffer).setUint32(4, Framing.maxPayload + 1)
				yield* writer.write(header)
				const reason = yield* Deferred.await(rejected)
				assert.include(reason, "payload length")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
	it.live(
		"keeps certificates with identical subjects in different authenticated namespaces",
		() =>
			Effect.gen(function* () {
				const { listener, port } = yield* server
				yield* listener
					.run((socket) =>
						Effect.gen(function* () {
							const identity = yield* Tls.Peer
							const peer = yield* Multiplex.fromSocket(socket)
							yield* peer.send(0, 0, bytes(identity))
							return yield* Effect.never
						}),
					)
					.pipe(Effect.forkScoped)
				const identities = yield* Effect.forEach(["client", "other"], (name) =>
					Effect.scoped(
						Effect.gen(function* () {
							const socket = yield* Tls.connect({
								host: "127.0.0.1",
								port,
								servername: "localhost",
								tls: yield* credentials(name),
							})
							const peer = yield* Multiplex.fromSocket(socket)
							const identity = yield* peer.take(0, 0)
							return text(identity)
						}),
					),
				)
				assert.notEqual(identities[0], identities[1])
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
})
