import { createSecureServer } from "node:http2"

import {
	Array,
	Cause,
	Clock,
	Context,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Logger,
	MutableList,
	Option,
	Redacted,
	Ref,
	Schema,
	String as Str,
	Stream,
} from "effect"
import { Digest, Mac, SecureRandom, Signature } from "effect/crypto"
import { FetchHttpClient, HttpClient, HttpServerResponse } from "effect/http"
import { Jwk, Jwt } from "effect/jose"
import {
	NodeHttpClient,
	NodeHttpServer,
	NodeServices,
	NodeSocket,
	NodeSocketServer,
} from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { inject } from "vitest"

import * as Auth from "../src/Auth"
import { AuthenticationFailed, TransportError } from "../src/Errors"
import hostBearer from "../src/host/auth/bearer"
import hostJwt from "../src/host/auth/jwt"
import { default as hostNone } from "../src/host/auth/none"
import hostUnix from "../src/host/unix"
import { default as hostWebsocket } from "../src/host/websocket"
import * as Remote from "../src/index"
import * as Assembly from "../src/internal/assembly"
import { Peer } from "../src/internal/Peer"
import * as Framing from "../src/internal/runner/Framing"
import { Supervisor } from "../src/internal/Supervisor"
import bearer from "../src/runner/auth/bearer"
import jwt from "../src/runner/auth/jwt"
import { default as none } from "../src/runner/auth/none"
import { consumer as listenerConsumer } from "../src/runner/consumer"
import { Config as StdioConfig } from "../src/runner/stdio"
import unix from "../src/runner/unix"
import { default as websocket } from "../src/runner/websocket"
import { Connector, Listener, type Channel } from "../src/Transport"
import { contract } from "./fixtures/contract"

const crypto = Layer.mergeAll(
	Digest.layerWebCrypto,
	Mac.layerWebCrypto,
	Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))
const runtimeWith = (http: Layer.Layer<HttpClient.HttpClient>) =>
	Graft.layer.pipe(
		Layer.provideMerge(Layer.mergeAll(NodeServices.layer, crypto, http)),
	)
const runtime = runtimeWith(FetchHttpClient.layer)
const availablePort = NodeSocketServer.make({
	host: "127.0.0.1",
	port: 0,
}).pipe(
	Effect.map((server) =>
		server.address._tag === "UnixPathAddress" ? 0 : server.address.port,
	),
	Effect.scoped,
)
const supervisor = Graft.provide(Supervisor, {
	accept: Effect.fnUntraced(function* (channel: Channel) {
		const identity = yield* Peer
		const frame = yield* Framing.encode({
			channel: 0,
			payload: new TextEncoder().encode(identity),
		}).pipe(
			Effect.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		)
		yield* Stream.succeed(frame).pipe(Stream.run(channel.output))
		yield* Stream.runDrain(channel.input)
	}),
})
const listen = Effect.fnUntraced(function* () {
	yield* supervisor
	const port = yield* availablePort
	const fork = yield* Graft.plugin(websocket, {
		url: `ws://127.0.0.1:${port}`,
	})
	yield* fork.await
	const consumer = yield* Graft.plugin(listenerConsumer())
	yield* consumer.await
	return port
})

const request = Effect.fnUntraced(function* (
	port: number,
	authorization?: string,
) {
	const socket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port })
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	yield* writer.write(
		"GET /graft HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: graft-remote.v1\r\n" +
			(authorization === undefined
				? ""
				: "Authorization: " + authorization + "\r\n") +
			"\r\n",
	)
	return yield* Stream.fromEffectRepeat(reader.pull).pipe(
		Stream.flattenIterable,
		Stream.map((bytes) =>
			typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
		),
		Stream.decodeText(),
		Stream.splitLines,
		Stream.takeUntil((line) => line === ""),
		Stream.map((line) => line + "\n"),
		Stream.mkString,
	)
}, Effect.scoped)
const refused = (response: string, missing = false) => {
	assert.include(response, "HTTP/1.1 401")
	assert.include(
		Str.toLowerCase(response),
		"www-authenticate: " +
			(missing ? "bearer\n" : 'bearer error="invalid_token"'),
	)
	assert.notInclude(response, "101 Switching Protocols")
	assert.notInclude(Str.toLowerCase(response), "sec-websocket-accept:")
}
const reject = (port: number, authorization?: string, missing = false) =>
	request(port, authorization).pipe(
		Effect.map((response) => refused(response, missing)),
	)
const capability = Effect.fnUntraced(function* <I, A>(
	key: Context.Service<I, A>,
) {
	const found = yield* Deferred.make<A>()
	const fork = yield* Graft.plugin(
		Plugin.make({
			name: "auth-test-consumer",
			inject: [key],
			apply: () =>
				key.pipe(
					Effect.flatMap((value) => Deferred.succeed(found, value)),
					Effect.asVoid,
				),
		}),
	)
	yield* fork.await
	return yield* Deferred.await(found)
})
const identity = Effect.fnUntraced(function* (
	channel: import("../src/Transport").Channel,
) {
	const first = yield* Stream.runHead(channel.input)
	const bytes = yield* Effect.fromOption(first)
	const frames = yield* Effect.fromResult(Framing.decoder().decode(bytes))
	const frame = yield* Effect.fromOption(Array.head(frames))
	return new TextDecoder().decode(frame.payload)
})
const withLogs = <A, E, R>(
	use: (read: () => ReadonlyArray<string>) => Effect.Effect<A, E, R>,
) =>
	Effect.suspend(() => {
		const messages = MutableList.make<string>()
		const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
			MutableList.append(messages, logLevel + ": " + String(message))
		})
		return use(() => MutableList.toArray(messages)).pipe(
			Effect.provide(Logger.layer([logger])),
		)
	})
const tokenFile = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	const digest = yield* Digest.Digest
	const hash = yield* digest.digestHex(
		Digest.sha256,
		new TextEncoder().encode("test-bearer-secret"),
	)
	const json = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
	)({ [hash]: "stable-host" })
	const file = directory + "/tokens.json"
	yield* fs.writeFileString(file, json)
	return file
})
const signing = Effect.gen(function* () {
	const pair = yield* Jwk.generateKeyPair({ algorithm: "ES256" })
	const key = yield* Jwk.importPrivate(pair.privateKey, "ES256")
	const publicKey = yield* Jwk.importPublic(pair.publicKey, "ES256")
	const pem = yield* Jwk.exportSpki(publicKey, { format: "pem" })
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = directory + "/public.pem"
	yield* fs.writeFileString(file, pem)
	const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
	const claims = {
		iss: "https://issuer.example",
		aud: "graft",
		sub: "jwt-host",
		exp: now + 300,
	}
	const sign = (value: Schema.Json) => Jwt.sign(Schema.Json, value, key)
	return { file, pair, claims, sign }
})

describe("runner authentication", () => {
	it.live(
		"authenticates bearer headers and challenges invalid or missing tokens before upgrade",
		() =>
			withLogs(
				Effect.fnUntraced(function* (logs) {
					const tokens = yield* tokenFile
					const auth = yield* Graft.plugin(bearer, { tokens })
					yield* auth.await
					const port = yield* listen()
					yield* reject(port, undefined, true)
					yield* reject(port, "Bearer wrong-secret")
					const success = yield* request(port, "Bearer test-bearer-secret")
					assert.include(success, "101 Switching Protocols")
					const transportPlugin = yield* Graft.plugin(hostWebsocket, {
						url: "ws://127.0.0.1:" + port,
					})
					const credentialsPlugin = yield* Graft.plugin(hostBearer, {
						token: "test-bearer-secret",
					})
					yield* transportPlugin.await
					yield* credentialsPlugin.await
					const transport = yield* capability(Connector)
					const credentials = yield* capability(Auth.Credentials)

					const received = yield* Effect.scoped(
						Effect.gen(function* () {
							const channel = yield* Assembly.connect.pipe(
								Effect.provideService(Connector, transport),
								Effect.provideService(Auth.Credentials, credentials),
							)
							return yield* identity(channel)
						}),
					)
					assert.equal(received, "stable-host")
					const messages = Array.join(logs(), "\n")
					assert.include(messages, "ws:// listener")
					assert.include(messages, "ws:// connection")
					assert.include(messages, "credentials are transmitted in plaintext")
					assert.notInclude(messages, "test-bearer-secret")
					assert.notInclude(messages, "wrong-secret")
				}),
			).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		"authenticates bearer credentials over Unix sockets without transport warnings",
		() =>
			withLogs(
				Effect.fnUntraced(function* (logs) {
					const tokens = yield* tokenFile
					const auth = yield* Graft.plugin(bearer, { tokens })
					yield* auth.await
					yield* supervisor
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped({
						directory: "/tmp",
						prefix: "graft-",
					})
					const path = directory + "/runner.sock"
					const listener = yield* Graft.plugin(unix, {
						path,
					})
					yield* listener.await
					const consumer = yield* Graft.plugin(listenerConsumer())
					yield* consumer.await
					const host = yield* Graft.plugin(hostUnix, { path })
					yield* host.await
					const transport = yield* capability(Connector)
					const channel = yield* transport.connect({
						_tag: "Authorization",
						value: Redacted.make("Bearer test-bearer-secret"),
					})
					const received = yield* identity(channel)
					assert.equal(received, "stable-host")
					assert.isFalse(
						Array.some(logs(), (line) => Str.startsWith("WARN")(line)),
					)
				}),
			).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.effect("rejects authentication in stdio listener configuration", () =>
		Schema.decodeUnknownEffect(StdioConfig)({
			auth: { none: {} },
		}).pipe(
			Effect.flip,
			Effect.map((error) => assert.include(error.message, "auth")),
		),
	)

	it.live(
		"verifies JWT signatures and claims and rejects them before upgrade",
		() =>
			Effect.gen(function* () {
				const keys = yield* signing
				const auth = yield* Graft.plugin(jwt, {
					issuer: keys.claims.iss,
					audience: ["graft"],
					algorithms: ["ES256"],
					keys: { publicKey: keys.file },
				})
				yield* auth.await
				const port = yield* listen()
				const valid = yield* keys.sign(keys.claims)
				const success = yield* request(port, "Bearer " + Redacted.value(valid))
				assert.include(success, "101 Switching Protocols")
				yield* reject(port, undefined, true)
				yield* reject(port, "Bearer invalid-jwt")
				const other = yield* Jwk.generateKeyPair({ algorithm: "ES256" })
				const otherKey = yield* Jwk.importPrivate(other.privateKey, "ES256")
				const wrongSignature = yield* Jwt.sign(
					Schema.Json,
					keys.claims,
					otherKey,
				)
				yield* reject(port, "Bearer " + Redacted.value(wrongSignature))
				// HTTP handshakes use the live clock; these tokens are already expired or not yet valid.
				for (const claims of [
					{ ...keys.claims, exp: 1 },
					{ ...keys.claims, nbf: keys.claims.exp + 1000 },
					{ iss: keys.claims.iss, aud: "graft", sub: "jwt-host" },
					{ ...keys.claims, iss: "https://other.example" },
					{ ...keys.claims, aud: "other" },
					{ ...keys.claims, sub: "" },
				]) {
					const invalid = yield* keys.sign(claims)
					yield* reject(port, "Bearer " + Redacted.value(invalid))
				}
				const secret = yield* Jwk.generateSecret("HS256")
				const hmac = yield* Jwk.importSecret(secret, "HS256")
				const symmetric = yield* Jwt.sign(Schema.Json, keys.claims, hmac)
				yield* reject(port, "Bearer " + Redacted.value(symmetric))
				const disallowed = yield* Jwk.generateKeyPair({ algorithm: "ES384" })
				const disallowedKey = yield* Jwk.importPrivate(
					disallowed.privateKey,
					"ES384",
				)
				const outsideList = yield* Jwt.sign(
					Schema.Json,
					keys.claims,
					disallowedKey,
				)
				yield* reject(port, "Bearer " + Redacted.value(outsideList))
				const healthy = yield* request(port, "Bearer " + Redacted.value(valid))
				assert.include(healthy, "101 Switching Protocols")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live("loads a remote JWKS and uses a configured identity claim", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const ca = yield* fs.readFileString(inject("remoteTls") + "/ca.crt")
			return yield* Effect.gen(function* () {
				const keys = yield* signing
				const fs = yield* FileSystem.FileSystem
				const cert = yield* fs.readFileString(
					inject("remoteTls") + "/server.crt",
				)
				const key = yield* fs.readFileString(
					inject("remoteTls") + "/server.key",
				)
				const server = yield* NodeHttpServer.make(
					() => createSecureServer({ allowHTTP1: true, cert, key }),
					{
						host: "127.0.0.1",
						port: 0,
					},
				)
				yield* server.serve(
					HttpServerResponse.json({ keys: [keys.pair.publicKey] }),
				)
				const port =
					server.address._tag === "UnixPathAddress" ? 0 : server.address.port
				const auth = yield* Graft.plugin(jwt, {
					issuer: keys.claims.iss,
					audience: ["graft"],
					algorithms: ["ES256"],
					identityClaim: "host",
					keys: { jwksUrl: "https://127.0.0.1:" + port + "/keys" },
				})
				yield* auth.await
				const listener = yield* listen()
				const token = yield* keys.sign({ ...keys.claims, host: "custom-host" })
				const credentialsPlugin = yield* Graft.plugin(hostJwt, {
					token: Redacted.value(token),
				})
				const transportPlugin = yield* Graft.plugin(hostWebsocket, {
					url: "ws://127.0.0.1:" + listener,
				})
				yield* credentialsPlugin.await
				yield* transportPlugin.await
				const credentials = yield* capability(Auth.Credentials)
				const transport = yield* capability(Connector)
				const prepared = yield* credentials.read
				const channel = yield* transport.connect(prepared)
				const received = yield* identity(channel)
				assert.equal(received, "custom-host")
			}).pipe(
				Effect.scoped,
				Effect.provide(
					runtimeWith(NodeHttpClient.layerNodeHttpOptions({ ca })),
				),
			)
		}).pipe(Effect.provide(NodeServices.layer)),
	)

	it.live(
		"warns for anonymous websocket startup and every connection, but not for unix",
		() =>
			withLogs(
				Effect.fnUntraced(function* (logs) {
					const auth = yield* Graft.plugin(none, { identity: "anonymous-host" })
					yield* auth.await
					// Raw upgrade requests close TCP without a WebSocket close frame. Drain that listener before measuring unix logs.
					yield* Effect.gen(function* () {
						const port = yield* listen()
						for (const authorization of [
							undefined,
							"Bearer ignored",
							"Basic ignored",
						]) {
							const response = yield* request(port, authorization)
							assert.include(response, "101 Switching Protocols")
						}
						assert.lengthOf(
							Array.filter(logs(), (line) =>
								Str.includes("WebSocket listener has no authentication")(line),
							),
							1,
						)
						assert.lengthOf(
							Array.filter(logs(), (line) =>
								Str.includes("WebSocket connection has no authentication")(
									line,
								),
							),
							3,
						)
						assert.isTrue(
							Array.some(logs(), (line) =>
								Str.includes("ws:// listener")(line),
							),
						)
					}).pipe(Effect.scoped)
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped({
						directory: "/tmp",
						prefix: "graft-",
					})
					const before = logs().length
					const listener = yield* Graft.plugin(unix, {
						path: directory + "/runner.sock",
					})
					yield* listener.await
					const consumer = yield* Graft.plugin(listenerConsumer())
					yield* consumer.await
					const transportPlugin = yield* Graft.plugin(hostUnix, {
						path: directory + "/runner.sock",
					})
					const credentialsPlugin = yield* Graft.plugin(hostNone, {})
					yield* transportPlugin.await
					yield* credentialsPlugin.await
					const transport = yield* capability(Connector)
					const credentials = yield* capability(Auth.Credentials)
					const prepared = yield* credentials.read
					const channel = yield* transport.connect(prepared)
					const received = yield* identity(channel)
					assert.equal(received, "anonymous-host")
					assert.lengthOf(logs(), before)
				}),
			).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live("reads an injected credential once per connection attempt", () =>
		Effect.gen(function* () {
			class Source extends Context.Service<
				Source,
				{ readonly token: Effect.Effect<Redacted.Redacted<string>> }
			>()("@graftland/plugin-remote/test/auth.test/Source") {}
			const reads = yield* Ref.make(0)
			yield* Graft.provide(Source, {
				token: Ref.update(reads, (n) => n + 1).pipe(
					Effect.as(Redacted.make("injected")),
				),
			})

			const connect = {
				instance: "worker",
				...{ url: "ws://127.0.0.1:1" },
				auth: {
					bearer: {
						token: {
							inject: [Source],
							read: Effect.flatMap(Source, (source) => source.token),
						},
					},
				},
			}
			for (const attempt of [1, 2]) {
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, {
						connect,
						contractModule: "unused",
					}),
					{ directory: "unused", mode: "normal", value: attempt },
				)
				yield* Effect.flip(fork.await)
			}
			const count = yield* Ref.get(reads)
			assert.strictEqual(count, 2)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it("accepts effect credentials on ws and unix", () => {
		const token = Effect.succeed(Redacted.make("test"))
		const websocket: Remote.Connect = {
			url: "ws://localhost",
			auth: { jwt: { token } },
		}
		const unix: Remote.Connect = {
			unix: "/tmp/test",
			auth: { bearer: { token } },
		}
		assert.equal(websocket.url, "ws://localhost")
		assert.equal(unix.unix, "/tmp/test")
	})
})

it.live("binds a websocket listener configured with an IPv6 literal URL", () =>
	Effect.gen(function* () {
		const provider = yield* Graft.plugin(websocket, { url: "ws://[::1]:0" })
		yield* provider.await
		const listener = yield* capability(Listener)
		const server = yield* listener.bind(Option.none())
		yield* server
			.serve(() => Effect.succeed(() => Effect.void))
			.pipe(Effect.forkScoped)
		yield* server.ready
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"retains an authentication rejection cause without logging its authorization header",
	() =>
		Effect.gen(function* () {
			const marker = new Error("JWKS unavailable")
			const logs = MutableList.make<Logger.Options<unknown>>()
			yield* Effect.gen(function* () {
				yield* Graft.provide(Auth.Authenticator, {
					_tag: "Header",
					authenticate: () =>
						Effect.fail(
							AuthenticationFailed.make({
								reason: "invalid",
								challenge: 'Bearer error="invalid_token"',
								cause: Cause.die(marker),
							}),
						),
				})
				const port = yield* listen()
				yield* reject(port, "Bearer private-test-credential")
			}).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make((log) => {
							MutableList.append(logs, log)
						}),
					]),
				),
			)
			assert.isTrue(
				Array.some(MutableList.toArray(logs), (log) =>
					Array.some(
						log.cause.reasons,
						(reason) => reason._tag === "Die" && reason.defect === marker,
					),
				),
			)
			assert.isFalse(
				Array.some(MutableList.toArray(logs), (log) =>
					Str.includes("private-test-credential")(String(log.message)),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)
