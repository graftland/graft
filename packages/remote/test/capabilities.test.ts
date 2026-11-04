import { assert, describe, it } from "@effect/vitest"
import {
	NodeServices,
	NodeSocketServer,
	NodeSocket,
} from "@effect/platform-node"
import { Graft, Plugin, type Fork } from "@graftland/graft"
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Option,
	Queue,
	Clock,
	Schema,
	Redacted,
	Sink,
	Stream,
} from "effect"
import { inject } from "vitest"
import { Digest, Signature, SecureRandom } from "effect/crypto"
import { Connector, Listener, type Channel } from "../src/Transport"
import { Credentials } from "../src/Auth"
import { Peer } from "../src/internal/Peer"
import { TransportError } from "../src/Errors"
import { Supervisor } from "../src/internal/Supervisor"
import websocket from "../src/host/websocket"
import listener from "../src/runner/websocket"
import credentials from "../src/host/auth/mtls"
import authenticator from "../src/runner/auth/mtls"
import hostUnix from "../src/host/unix"
import hostCommand from "../src/host/command"
import runnerUnix from "../src/runner/unix"
import runnerStdio from "../src/runner/stdio"
import hostNone from "../src/host/auth/none"
import hostBearer from "../src/host/auth/bearer"
import hostJwt from "../src/host/auth/jwt"
import runnerNone from "../src/runner/auth/none"
import runnerBearer from "../src/runner/auth/bearer"
import runnerJwt from "../src/runner/auth/jwt"
import { Jwk, Jwt } from "effect/jose"
import { FetchHttpClient } from "effect/http"
import process from "node:process"
import * as Assembly from "../src/internal/assembly"
import * as Certificates from "../src/internal/Certificates"
import * as Framing from "../src/internal/runner/Framing"
import * as Conformance from "../src/Testing"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			NodeServices.layer,
			Digest.layerWebCrypto,
			Signature.layerWebCrypto,
			FetchHttpClient.layer,
		).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto)),
	),
)
class Business extends Context.Service<Business, string>()(
	"@graftland/plugin-remote/test/capabilities.test/Business",
) {}
const find = (
	trees: ReadonlyArray<Fork.ForkTree>,
	id: number,
): Option.Option<Fork.ForkTree> =>
	Array.findFirst(trees, (tree) =>
		tree.id === id ? Option.some(tree) : find(tree.children, id),
	)
const active = (tree: Fork.ForkTree): boolean =>
	tree.state._tag === "Active" && Array.every(tree.children, active)
const check = (
	tree: Fork.ForkTree,
): Effect.Effect<void, Assembly.CapabilityFailed> =>
	tree.state._tag === "Failed"
		? Effect.fail(Assembly.CapabilityFailed.make({ cause: tree.state.cause }))
		: Effect.forEach(tree.children, check, { discard: true })
const ready = (fork: Fork.Fork) =>
	Graft.forks.pipe(
		Stream.map((trees) => find(trees, fork.id)),
		Stream.filter(Option.isSome),
		Stream.map((tree) => tree.value),
		Stream.tap(check),
		Stream.filter(active),
		Stream.runHead,
	)
const failed = (fork: Fork.Fork) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag === "Failed"),
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
	)
const port = NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(
	Effect.map((server) =>
		server.address._tag === "UnixPathAddress" ? 0 : server.address.port,
	),
	Effect.scoped,
)
const implementations = {
	connector: websocket,
	listener,
	credentials,
	authenticator,
}
const pair = Effect.fnUntraced(function* (
	identity: string,
	plugins: Conformance.Capabilities = implementations,
) {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	yield* Certificates.generate({
		out: directory,
		server: ["127.0.0.1"],
		identity: [identity],
		days: 2,
		force: false,
	})
	const address = yield* port
	return {
		directory,
		address,
		server: {
			transport: {
				plugin: plugins.listener,
				config: {
					url: `wss://127.0.0.1:${address}`,
					cert: directory + "/server.crt",
					key: directory + "/server.key",
				},
			},
			auth: {
				plugin: plugins.authenticator,
				config: { ca: directory + "/ca.crt" },
			},
		},
		host: {
			transport: {
				plugin: plugins.connector,
				config: {
					url: `wss://127.0.0.1:${address}`,
					ca: directory + "/ca.crt",
				},
			},
			auth: {
				plugin: plugins.credentials,
				config: {
					cert: directory + "/client-" + identity + ".crt",
					key: directory + "/client-" + identity + ".key",
				},
			},
		},
	}
})

const echo = Effect.gen(function* () {
	const closed = yield* Deferred.make<void>()
	const peers = yield* Deferred.make<{
		readonly identity: string
		readonly business: string
	}>()
	const business = yield* Business
	yield* Graft.provide(Supervisor, {
		accept: (channel) =>
			Peer.pipe(
				Effect.flatMap((identity) =>
					Deferred.succeed(peers, { identity, business }).pipe(
						Effect.andThen(Stream.run(channel.input, channel.output)),
						Effect.ensuring(Deferred.succeed(closed, undefined)),
						Effect.asVoid,
					),
				),
			),
	})
	return { closed, peers }
})
const supervisor = Plugin.make({
	name: "fake-supervisor",
	inject: [Business],
	apply: () => echo.pipe(Effect.asVoid),
})
const host = Effect.fnUntraced(function* (
	input: Omit<Assembly.Input, "consumer">,
) {
	const found = yield* Deferred.make<Channel>()
	const business = yield* Deferred.make<string>()
	const fork = yield* Assembly.host({
		...input,
		consumer: Plugin.make({
			name: "test-connection",
			inject: [Connector, Credentials, Business],
			apply: () =>
				Effect.gen(function* () {
					const value = yield* Business
					yield* Deferred.succeed(business, value)
					const channel = yield* Assembly.connect
					yield* Deferred.succeed(found, channel)
				}),
		}),
	})
	yield* ready(fork)
	const value = yield* Deferred.await(business)
	assert.equal(value, "inherited")
	return yield* Deferred.await(found)
})
const connection = (plugins: Conformance.Capabilities) =>
	Effect.gen(function* () {
		yield* Graft.provide(Business, "inherited")
		const provider = yield* Graft.plugin(supervisor)
		yield* provider.await
		const config = yield* pair("echo", plugins)
		const server = yield* Assembly.runner(config.server)
		yield* ready(server)
		return yield* host(config.host)
	})
const checks = Conformance.transport(implementations, connection)

describe("capability conformance: websocket and mTLS", () => {
	it.live("preserves byte order across split and coalesced frames", () =>
		checks.chunks.pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live("exposes clean close as EOF, not TransportError", () =>
		checks.eof.pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		"isolates two configured assemblies while inheriting business services",
		() =>
			Effect.gen(function* () {
				yield* Graft.provide(Business, "inherited")
				const observed = yield* Queue.unbounded<{
					readonly identity: string
					readonly business: string
				}>()
				const provider = yield* Graft.plugin(
					Plugin.make({
						name: "observed-supervisor",
						inject: [Business],
						apply: Effect.fnUntraced(function* () {
							const business = yield* Business
							yield* Graft.provide(Supervisor, {
								accept: (channel) =>
									Peer.pipe(
										Effect.flatMap((identity) =>
											Queue.offer(observed, { identity, business }).pipe(
												Effect.andThen(
													Stream.run(channel.input, channel.output),
												),
												Effect.asVoid,
											),
										),
									),
							})
						}),
					}),
				)
				yield* provider.await
				const left = yield* pair("left")
				const right = yield* pair("right")
				const servers = yield* Effect.forEach([left, right], (config) =>
					Assembly.runner(config.server),
				)
				yield* Effect.forEach(servers, ready)
				const clients = yield* Effect.forEach([left, right], (config) =>
					host(config.host),
				)
				// Both remain alive in the same user realm, without a service-key collision.
				yield* Effect.forEach(
					clients,
					(channel) =>
						Conformance.transport(implementations, () =>
							Effect.succeed(channel),
						).chunks,
				)
				const peers = yield* Effect.all([
					Queue.take(observed),
					Queue.take(observed),
				])
				assert.sameMembers(
					Array.map(peers, (peer) => peer.identity),
					["graft://left", "graft://right"],
				)
				assert.deepEqual(
					Array.map(peers, (peer) => peer.business),
					["inherited", "inherited"],
				)
				// Swapping only the server CA cannot connect to the other assembly.
				const wrong = yield* Assembly.host({
					...left.host,
					transport: {
						...left.host.transport,
						config: {
							url: `wss://127.0.0.1:${right.address}`,
							ca: left.directory + "/ca.crt",
						},
					},
					consumer: Plugin.make({
						name: "wrong-ca",
						inject: [Connector, Credentials],
						apply: () => Assembly.connect.pipe(Effect.asVoid),
					}),
				})
				const failure = yield* failed(wrong)
				if (failure._tag === "Failed")
					assert.include(Cause.pretty(failure.cause), "TransportError")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live("waits for a nested provider after its parent becomes active", () =>
		Effect.gen(function* () {
			const publish = yield* Deferred.make<void>()
			const child = Plugin.service(
				Connector,
				Deferred.await(publish).pipe(
					Effect.as({
						properties: {
							protocol: "test",
							encrypted: false,
							network: false,
							carries: [],
						},
						connect: () => Effect.never,
					}),
				),
				{ name: "delayed-connector" },
			)
			const assembly = yield* Assembly.host({
				transport: {
					plugin: Plugin.make({
						name: "active-parent",
						apply: () => Graft.plugin(child).pipe(Effect.asVoid),
					}),
					config: undefined,
				},
				auth: {
					plugin: Plugin.service(
						Credentials,
						Effect.succeed({
							kind: "None",
							read: Effect.succeed({ _tag: "None" }),
						}),
						{ name: "none" },
					),
					config: undefined,
				},
				consumer: Plugin.make({
					name: "waiting-connector",
					inject: [Connector, Credentials],
					apply: () => Effect.void,
				}),
			})
			const tree = yield* Graft.forks.pipe(
				Stream.map((trees) => find(trees, assembly.id)),
				Stream.filter(Option.isSome),
				Stream.map((tree) => tree.value),
				Stream.tap(check),
				Stream.filter(
					(tree) =>
						Array.some(
							tree.children,
							(child) =>
								child.name === "active-parent" && child.state._tag === "Active",
						) &&
						Array.some(
							tree.children,
							(child) => child.name === "none" && child.state._tag === "Active",
						) &&
						Array.some(
							tree.children,
							(child) =>
								child.name === "waiting-connector" &&
								child.state._tag === "Pending",
						),
				),
				Stream.runHead,
				Effect.flatMap(Effect.fromOption),
			)
			const parent = yield* Effect.fromOption(
				Array.findFirst(
					tree.children,
					(child) => child.name === "active-parent",
				),
			)
			assert.equal(parent.state._tag, "Active")
			assert.equal(parent.children[0]?.state._tag, "Loading")
			const consumer = yield* Effect.fromOption(
				Array.findFirst(
					tree.children,
					(child) => child.name === "waiting-connector",
				),
			)
			assert.equal(consumer.state._tag, "Pending")
			// Credentials may still appear here until the consumer resolves its dependencies again.
			if (consumer.state._tag === "Pending")
				assert.include(consumer.state.missing, Connector.key)
			yield* Deferred.succeed(publish, undefined)
			yield* ready(assembly)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		"reports an active capability subtree that never publishes its key",
		() =>
			Effect.gen(function* () {
				const empty = Plugin.make({
					name: "empty-provider",
					apply: () => Effect.void,
				})
				const nested = Plugin.make({
					name: "nested-provider",
					apply: () => Graft.plugin(empty).pipe(Effect.asVoid),
				})
				const fork = yield* Assembly.host({
					transport: { plugin: nested, config: undefined },
					auth: {
						plugin: Plugin.service(
							Credentials,
							Effect.succeed({
								kind: "None",
								read: Effect.succeed({ _tag: "None" }),
							}),
							{ name: "none" },
						),
						config: undefined,
					},
					consumer: Plugin.make({
						name: "waiting",
						inject: [Connector, Credentials],
						apply: () => Effect.void,
					}),
				})
				const result = yield* failed(fork)
				if (result._tag === "Failed") {
					assert.include(Cause.pretty(result.cause), "CapabilityContractError")
					assert.include(Cause.pretty(result.cause), Connector.key)
				}
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		"closes the accepted session when the client assembly scope is cancelled",
		() =>
			Effect.gen(function* () {
				yield* Graft.provide(Business, "inherited")
				const ended = yield* Deferred.make<void>()
				yield* Graft.provide(Supervisor, {
					accept: (channel) =>
						Stream.run(channel.input, channel.output).pipe(
							Effect.ensuring(Deferred.succeed(ended, undefined)),
							Effect.asVoid,
						),
				})
				const config = yield* pair("cancel")
				const server = yield* Assembly.runner(config.server)
				yield* ready(server)
				yield* host(config.host).pipe(Effect.scoped)
				yield* Deferred.await(ended)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		"rejects a trusted certificate with no identity before upgrading",
		() =>
			Effect.gen(function* () {
				yield* Graft.provide(Supervisor, { accept: () => Effect.never })
				const directory = inject("remoteTls")
				const address = yield* port
				const server = yield* Assembly.runner({
					transport: {
						plugin: listener,
						config: {
							url: `wss://127.0.0.1:${address}`,
							cert: directory + "/server.crt",
							key: directory + "/server.key",
						},
					},
					auth: {
						plugin: authenticator,
						config: { ca: directory + "/ca.crt" },
					},
				})
				yield* ready(server)
				const fs = yield* FileSystem.FileSystem
				const ca = yield* fs.readFileString(directory + "/ca.crt")
				const cert = yield* fs.readFileString(directory + "/missing.crt")
				const key = yield* fs.readFileString(directory + "/missing.key")
				const response = Effect.gen(function* () {
					const socket = yield* NodeSocket.makeTls({
						host: "127.0.0.1",
						port: address,
						servername: "localhost",
						ca,
						cert,
						key,
						rejectUnauthorized: true,
					})
					const reader = yield* socket.reader
					const writer = yield* socket.writer
					yield* writer.write(
						"GET /graft HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: graft-remote.v1\r\n\r\n",
					)
					const received = yield* reader.pull
					return Array.join(
						Array.map(received, (value) =>
							typeof value === "string"
								? value
								: new TextDecoder().decode(value),
						),
						"",
					)
				}).pipe(Effect.scoped)
				yield* Conformance.rejection(response)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		"reads file credentials for each connection and preserves the source failure",
		() =>
			Effect.gen(function* () {
				const config = yield* pair("rotate")
				const found = yield* Deferred.make<typeof Credentials.Service>()
				const assembly = yield* Assembly.host({
					...config.host,
					consumer: Plugin.make({
						name: "credentials-consumer",
						inject: [Credentials, Connector],
						apply: () =>
							Credentials.pipe(
								Effect.flatMap((api) => Deferred.succeed(found, api)),
								Effect.asVoid,
							),
					}),
				})
				yield* ready(assembly)
				const api = yield* Deferred.await(found)
				assert.equal(api.kind, "Certificate")
				if (api.kind !== "Certificate") return
				const prepared = yield* api.read
				assert.equal(prepared._tag, "Certificate")
				const fs = yield* FileSystem.FileSystem
				yield* fs.remove(config.directory + "/client-rotate.key")
				const result = yield* Effect.exit(api.read)
				assert.equal(result._tag, "Failure")
				if (result._tag === "Failure") {
					assert.include(Cause.pretty(result.cause), "CredentialsError")
					assert.include(Cause.pretty(result.cause), "client-rotate.key")
				}
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		"reports serve failure before ready and passes TLS policy to bind",
		() =>
			Effect.gen(function* () {
				yield* Graft.provide(Supervisor, { accept: () => Effect.never })
				const bound = yield* Deferred.make<boolean>()
				const config = yield* pair("readiness")
				const broken = Plugin.service(
					Listener,
					Effect.succeed({
						properties: {
							protocol: "wss",
							encrypted: true,
							network: true,
							carries: ["certificate"],
						},
						bind: (tls) =>
							Deferred.succeed(
								bound,
								Option.isSome(tls) &&
									tls.value.minVersion === "TLSv1.3" &&
									tls.value.requestCert &&
									tls.value.rejectUnauthorized,
							).pipe(
								Effect.as({
									ready: Effect.never,
									serve: () =>
										Effect.fail(
											TransportError.make({
												cause: Cause.die(new Error("accept loop failed")),
											}),
										),
								}),
							),
					}),
					{ name: "failing-listener" },
				)
				const assembly = yield* Assembly.runner({
					transport: { plugin: broken, config: undefined },
					auth: config.server.auth,
				})
				const failure = yield* failed(assembly)
				const policy = yield* Deferred.await(bound)
				assert.isTrue(policy)
				if (failure._tag === "Failed")
					assert.include(Cause.pretty(failure.cause), "accept loop failed")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live("keeps a genuinely missing business dependency Pending", () =>
		Effect.gen(function* () {
			const config = yield* pair("pending")
			const assembly = yield* Assembly.host({
				...config.host,
				consumer: Plugin.make({
					name: "waiting-business",
					inject: [Connector, Credentials, Business],
					apply: () => Effect.void,
				}),
			})
			yield* assembly.await
			const tree = yield* Graft.forks.pipe(
				Stream.map((trees) => find(trees, assembly.id)),
				Stream.filter(Option.isSome),
				Stream.map((tree) => tree.value),
				Stream.filter((tree) =>
					Array.some(
						tree.children,
						(child) =>
							child.name === "waiting-business" &&
							child.state._tag === "Pending",
					),
				),
				Stream.runHead,
			)
			assert.isTrue(Option.isSome(tree))
			if (Option.isSome(tree)) assert.equal(tree.value.state._tag, "Active")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
})

const remaining = [
	{
		name: "unix/none",
		connector: hostUnix,
		listener: runnerUnix,
		credentials: hostNone,
		authenticator: runnerNone,
	},
	{
		name: "command/stdio",
		connector: hostCommand,
		listener: runnerStdio,
		credentials: hostNone,
		authenticator: runnerNone,
	},
	{
		name: "websocket/none",
		connector: websocket,
		listener,
		credentials: hostNone,
		authenticator: runnerNone,
	},
	{
		name: "websocket/bearer",
		connector: websocket,
		listener,
		credentials: hostBearer,
		authenticator: runnerBearer,
	},
	{
		name: "websocket/jwt",
		connector: websocket,
		listener,
		credentials: hostJwt,
		authenticator: runnerJwt,
	},
]
const tokenConfig = Effect.fnUntraced(function* (
	name: string,
	directory: string,
) {
	const fs = yield* FileSystem.FileSystem
	if (name === "websocket/bearer") {
		const digest = yield* Digest.Digest
		const token = "conformance-token"
		const hash = yield* digest.digestHex(
			Digest.sha256,
			new TextEncoder().encode(token),
		)
		const tokens = directory + "/tokens.json"
		const json = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Unknown),
		)({ [hash]: "echo" })
		yield* fs.writeFileString(tokens, json)
		return { host: { token }, server: { tokens } }
	}
	if (name === "websocket/jwt") {
		const pair = yield* Jwk.generateKeyPair({ algorithm: "ES256" })
		const key = yield* Jwk.importPrivate(pair.privateKey, "ES256")
		const publicKey = yield* Jwk.importPublic(pair.publicKey, "ES256")
		const pem = yield* Jwk.exportSpki(publicKey, { format: "pem" })
		const file = directory + "/public.pem"
		yield* fs.writeFileString(file, pem)
		const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
		const token = yield* Jwt.sign(
			Schema.Json,
			{
				iss: "https://issuer.example",
				aud: "graft",
				sub: "echo",
				exp: now + 300,
			},
			key,
		)
		return {
			host: { token: Redacted.value(token) },
			server: {
				issuer: "https://issuer.example",
				audience: ["graft"],
				algorithms: ["ES256"],
				keys: { publicKey: file },
			},
		}
	}
	return { host: {}, server: { identity: "echo" } }
})
const remainingConnection =
	(name: string) => (plugins: Conformance.Capabilities) =>
		Effect.gen(function* () {
			yield* Graft.provide(Business, "inherited")
			const provider = yield* Graft.plugin(supervisor)
			yield* provider.await
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped({
				directory: "/tmp",
				prefix: "graft-",
			})
			const auth = yield* tokenConfig(name, directory)
			const address = yield* port
			const config =
				name === "unix/none"
					? { path: directory + "/echo.sock" }
					: { url: `ws://127.0.0.1:${address}` }
			if (name !== "command/stdio") {
				const server = yield* Assembly.runner({
					transport: { plugin: plugins.listener, config },
					auth: { plugin: plugins.authenticator, config: auth.server },
				})
				yield* ready(server)
			}
			return yield* host({
				transport: {
					plugin: plugins.connector,
					config:
						name === "command/stdio"
							? {
									argv: [
										process.execPath,
										new URL(
											"../.cache/integration/stdio-echo.js",
											import.meta.url,
										).pathname,
									],
								}
							: config,
				},
				auth: { plugin: plugins.credentials, config: auth.host },
			})
		})
for (const implementation of remaining) {
	const checks = Conformance.transport(
		implementation,
		remainingConnection(implementation.name),
	)
	describe(`capability conformance: ${implementation.name}`, () => {
		it.live("preserves byte order across split and coalesced frames", () =>
			checks.chunks.pipe(Effect.scoped, Effect.provide(runtime)),
		)
		it.live("exposes clean close as EOF", () =>
			checks.eof.pipe(Effect.scoped, Effect.provide(runtime)),
		)
	})
}

it.effect("rejects a transport that changes a frame channel", () =>
	Effect.gen(function* () {
		const first = yield* Framing.encode({
			channel: 0,
			payload: new Uint8Array([1, 2, 3]),
		})
		const second = yield* Framing.encode({
			channel: 0,
			payload: new Uint8Array([4, 5]),
		})
		const result = yield* Conformance.transport(implementations, () =>
			Effect.succeed({ input: Stream.make(first, second), output: Sink.drain }),
		).chunks.pipe(Effect.result)
		assert(result._tag === "Failure")
		assert.isTrue(Schema.is(Conformance.ConformanceError)(result.failure))
	}).pipe(Effect.scoped),
)
