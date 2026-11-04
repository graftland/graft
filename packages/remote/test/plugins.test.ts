import { assert, describe, it } from "@effect/vitest"
import { NodeServices, NodeSocketServer } from "@effect/platform-node"
import { Graft, Plugin, type Fork } from "@graftland/graft"
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Stream,
	Schema,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { inject } from "vitest"
import * as Remote from "../src/index"
import { executionPlugin } from "../src/internal/execution"
import { Supervisor } from "../src/Supervisor"
import { LocalTransport } from "../src/Transport"
import { MtlsAuthenticator } from "../src/Auth"
import local from "../src/host/local"
import supervisor from "../src/runner/supervisor"
import { legacy as mtls } from "../src/runner/auth/mtls"
import {
	legacy as websocket,
	Config as WebsocketConfig,
} from "../src/runner/websocket"
import unix from "../src/runner/unix"
import * as Lock from "../src/internal/runner/Lock"
import * as Websocket from "./websocket"
import { contract } from "./fixtures/contract"

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
					auth: MtlsAuthenticator.key,
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
				}).pipe(Effect.exit)
				assert.isTrue(Exit.isFailure(rejected))
				if (Exit.isFailure(rejected))
					assert.include(Cause.pretty(rejected.cause), "no path or /graft")
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
				{ url: "ws://localhost:7443", auth: MtlsAuthenticator.key },
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
				class Custom extends Context.Service<
					Custom,
					typeof MtlsAuthenticator.Service
				>()("@graftland/plugin-remote/test/plugins.test/Custom") {}
				yield* Graft.provide(Custom, {
					_tag: "Mtls",
					ca: "unused",
					authenticate: () => Effect.succeed("unused"),
				})
				yield* Graft.provide(Supervisor, { accept: () => Effect.void })
				const network = yield* Graft.plugin(websocket, {
					url: "ws://localhost:0",
					auth: Custom.key,
				})
				const networkError = yield* Effect.flip(network.await)
				assert.equal(networkError._tag, "ListenerConfigError")
				const local = yield* Graft.plugin(unix, {
					path: "unused.sock",
					auth: Custom.key,
				})
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
					},
					Remote.local(),
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
				const listener = yield* Graft.plugin(websocket, {
					url: `wss://127.0.0.1:${port}`,
					cert: inject("remoteTls") + "/server.crt",
					key: inject("remoteTls") + "/server.key",
					auth: MtlsAuthenticator.key,
				})
				yield* listener.await
				yield* connection(port).pipe(Effect.scoped)
				yield* auth.dispose
				const state = yield* Graft.forks.pipe(
					Stream.map((trees: ReadonlyArray<Fork.ForkTree>) =>
						Array.flatMap(
							Array.filter(
								trees,
								(tree: Fork.ForkTree) => tree.id === listener.id,
							),
							(tree: Fork.ForkTree) => tree.children,
						),
					),
					Stream.flattenIterable,
					Stream.map((tree) => tree.state),
					Stream.filter((state) => state._tag === "Pending"),
					Stream.runHead,
				)
				assert.deepEqual(Option.getOrThrow(state), {
					_tag: "Pending",
					missing: [MtlsAuthenticator.key],
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
