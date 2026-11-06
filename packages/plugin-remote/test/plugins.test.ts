import {
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Schema,
	Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { NodeServices, NodeSocketServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { inject } from "vitest"

import { Authenticator } from "../src/Auth"
import local from "../src/host/local"
import { LocalTransport } from "../src/internal/directTransport"
import { executionPlugin } from "../src/internal/execution"
import * as Lock from "../src/internal/runner/Lock"
import { Supervisor } from "../src/internal/Supervisor"
import { default as mtls } from "../src/runner/auth/mtls"
import { consumer } from "../src/runner/consumer"
import supervisor from "../src/runner/supervisor"
import unix from "../src/runner/unix"
import {
	default as websocket,
	Config as WebsocketConfig,
} from "../src/runner/websocket"
import { contract } from "./fixtures/contract"
import * as Websocket from "./websocket"

const runtime = Layer.provideMerge(
	Graft.layer,
	Layer.mergeAll(
		NodeServices.layer,
		SecureRandom.layerWebCrypto,
		Digest.layerWebCrypto,
	),
)
const capture = Effect.gen(function* () {
	const result = yield* Deferred.make<typeof Supervisor.Service>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "supervisor-observer",
			inject: [Supervisor],
			apply: () =>
				Effect.flatMap(Supervisor, (value) =>
					Deferred.succeed(result, value),
				).pipe(Effect.asVoid),
		}),
	)
	yield* consumer.await
	return yield* Deferred.await(result)
})
const availablePort = NodeSocketServer.make({
	host: "127.0.0.1",
	port: 0,
}).pipe(
	Effect.map((server) => {
		assert.notEqual(server.address._tag, "UnixPathAddress")
		return server.address._tag === "UnixPathAddress" ? 0 : server.address.port
	}),
	Effect.scoped,
)
const connection = Effect.fnUntraced(function* (port: number) {
	const fs = yield* FileSystem.FileSystem
	const root = inject("remoteTls")
	const key = yield* fs.readFileString(root + "/client.key")
	const socket = yield* Websocket.connect({
		port,
		servername: "localhost",
		tls: {
			ca: yield* fs.readFileString(root + "/ca.crt"),
			cert: yield* fs.readFileString(root + "/client.crt"),
			key: Redacted.make(key),
		},
	})
	yield* socket.reader
})

describe("remote capability plugins", () => {
	it.effect(
		"rejects listener URLs with a path other than /graft during decoding",
		() =>
			Effect.gen(function* () {
				const config = {
					cert: "unused.crt",
					key: "unused.key",
				}
				for (const url of [
					"wss://localhost:7443",
					"wss://localhost:7443/graft",
				]) {
					const decoded = yield* Schema.decodeEffect(WebsocketConfig)({
						...config,
						url,
					})
					assert.equal(decoded.url.href, new URL(url).href)
				}
				const rejected = yield* Schema.decodeEffect(WebsocketConfig)({
					...config,
					url: "wss://localhost:7443/other",
				}).pipe(Effect.flip)
				assert.isTrue(Schema.isSchemaError(rejected))
				assert.include(rejected.message, "no path or /graft")
			}),
	)

	it.effect("decodes certificate requirements by listener protocol", () =>
		Effect.gen(function* () {
			const plain = yield* Schema.decodeEffect(WebsocketConfig)({
				url: "ws://localhost:7443",
			})
			assert.equal(plain._tag, "ws")
			const secure = yield* Schema.decodeEffect(WebsocketConfig)({
				url: "wss://localhost:7443",
				cert: "server.crt",
				key: "server.key",
			})
			assert.equal(secure._tag, "wss")
			for (const config of [
				{ url: "ws://localhost:7443", cert: "server.crt" },
				{ url: "ws://localhost:7443", key: "server.key" },
				{ url: "wss://localhost:7443" },
				{ url: "wss://localhost:7443", cert: "server.crt" },
				{ url: "wss://localhost:7443", key: "server.key" },
				{ url: "ws://localhost:7443", auth: Authenticator.key },
			]) {
				const result = yield* Schema.decodeUnknownEffect(WebsocketConfig)(
					config,
				).pipe(Effect.exit)
				assert.isTrue(Exit.isFailure(result))
			}
		}),
	)

	it.live(
		"reports third-party mTLS on ws or unix as a listener configuration error",
		() =>
			Effect.gen(function* () {
				yield* Graft.provide(Authenticator, {
					_tag: "Mtls",
					tls: {
						ca: ["unused"],
						minVersion: "TLSv1.3",
						requestCert: true,
						rejectUnauthorized: true,
					},
					authenticate: () => Effect.succeed("unused"),
				})
				yield* Graft.provide(Supervisor, { accept: () => Effect.void })
				const networkProvider = yield* Graft.plugin(websocket, {
					url: "ws://localhost:0",
				})
				yield* networkProvider.await
				const network = yield* Graft.plugin(consumer())
				const networkError = yield* Effect.flip(network.await)
				yield* network.dispose
				yield* networkProvider.dispose
				assert.equal(networkError._tag, "ListenerConfigError")
				const localProvider = yield* Graft.plugin(unix, {
					path: "unused.sock",
				})
				yield* localProvider.await
				const local = yield* Graft.plugin(consumer())
				const localError = yield* Effect.flip(local.await)
				assert.equal(localError._tag, "ListenerConfigError")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live("withdraws the proxy before its local transport is released", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			yield* fs.writeFileString(directory + "/release", "release")
			const provider = yield* Graft.plugin(local)
			yield* provider.await
			const proxy = yield* Graft.plugin(
				executionPlugin(
					contract,
					{
						contractModule: new URL(
							"../.cache/integration/contract.js",
							import.meta.url,
						).href,
						implementation: new URL(
							"../.cache/integration/plugin.js",
							import.meta.url,
						).href,
					},
					{ _tag: "Local" },
				),
				{ directory, mode: "normal", value: 1 },
			)
			yield* proxy.await
			const active = yield* Stream.runHead(proxy.state)
			assert.equal(Option.getOrThrow(active)._tag, "Active")
			yield* provider.dispose
			const state = yield* proxy.state.pipe(
				Stream.filter((state) => state._tag === "Pending"),
				Stream.runHead,
			)
			assert.deepEqual(Option.getOrThrow(state), {
				_tag: "Pending",
				missing: [LocalTransport.key],
			})
		}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		"closes a WebSocket listener when authentication is withdrawn without restarting the supervisor",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const owner = yield* Graft.plugin(supervisor, {
					root: inject("remoteRoot"),
					state: directory,
				})
				yield* owner.await
				const before = yield* capture
				const auth = yield* Graft.plugin(mtls, {
					ca: inject("remoteTls") + "/ca.crt",
				})
				yield* auth.await
				const port = yield* availablePort
				const provider = yield* Graft.plugin(websocket, {
					url: `wss://127.0.0.1:${port}`,
					cert: inject("remoteTls") + "/server.crt",
					key: inject("remoteTls") + "/server.key",
				})
				yield* provider.await
				const listener = yield* Graft.plugin(consumer())
				yield* listener.await
				yield* connection(port).pipe(Effect.scoped)
				yield* auth.dispose
				const state = yield* listener.state.pipe(
					Stream.filter((state) => state._tag === "Pending"),
					Stream.runHead,
				)
				assert.deepEqual(Option.getOrThrow(state), {
					_tag: "Pending",
					missing: [Authenticator.key],
				})
				const refused = yield* connection(port).pipe(Effect.scoped, Effect.exit)
				assert.isTrue(Exit.isFailure(refused))
				const active = yield* Stream.runHead(owner.state)
				assert.equal(Option.getOrThrow(active)._tag, "Active")
				const after = yield* capture
				assert.strictEqual(after, before)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live("holds the directory lock until the supervisor is withdrawn", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const owner = yield* Graft.plugin(supervisor, {
				root: inject("remoteRoot"),
				state: directory,
			})
			yield* owner.await
			const occupied = yield* Lock.acquire(directory).pipe(
				Effect.scoped,
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(occupied))
			yield* owner.dispose
			const released = yield* Lock.acquire(directory).pipe(
				Effect.scoped,
				Effect.exit,
			)
			assert.isTrue(Exit.isSuccess(released))
		}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
})
