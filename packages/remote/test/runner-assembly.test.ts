import { assert, it } from "@effect/vitest"
import { NodeServices, NodeSocketServer } from "@effect/platform-node"
import { Graft, Plugin, type Fork } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Schema,
	Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { RpcClient } from "effect/rpc"
import { inject } from "vitest"
import runner from "../src/runner/index"
import websocket from "../src/runner/websocket"
import none from "../src/runner/auth/none"
import bearer from "../src/runner/auth/bearer"
import { Authenticator } from "../src/Auth"
import { Listener } from "../src/Transport"
import { Supervisor } from "../src/Supervisor"
import { AuthenticationFailed, TransportError } from "../src/Errors"
import { make as connector } from "../src/host/websocket"
import { properties } from "../src/internal/websocket"
import * as Multiplex from "../src/internal/runner/Multiplex"
import * as Port from "../src/internal/port"
import * as Wire from "../src/internal/runner/Wire"
import { defaults } from "../src/internal/runner/model"

const header = Plugin.make({
	name: "test-header-authenticator",
	config: Schema.Struct({
		issuer: Schema.String,
		token: Schema.String,
		identity: Schema.String,
	}),
	apply: (config) =>
		Graft.provide(Authenticator, {
			_tag: "Header",
			issuer: config.issuer,
			authenticate: (authorization) =>
				Option.isNone(authorization)
					? Effect.fail(
							AuthenticationFailed.make({
								reason: "missing",
								challenge: "Bearer",
							}),
						)
					: Redacted.value(authorization.value) === `Bearer ${config.token}`
						? Effect.succeed(config.identity)
						: Effect.fail(
								AuthenticationFailed.make({
									reason: "invalid",
									challenge: 'Bearer error="invalid_token"',
								}),
							),
		}),
})
const platform = Layer.mergeAll(
	NodeServices.layer,
	Digest.layerWebCrypto,
	SecureRandom.layerWebCrypto,
)
const runtime = Graft.layer.pipe(Layer.provideMerge(platform))
const availablePort = NodeSocketServer.make({
	host: "127.0.0.1",
	port: 0,
}).pipe(
	Effect.map((server) =>
		server.address._tag === "UnixPathAddress" ? 0 : server.address.port,
	),
	Effect.scoped,
)
const resolver = (additional: Readonly<Record<string, Plugin.Plugin>> = {}) =>
	ModuleResolver.fromRecord({
		"@graftland/plugin-remote/runner/websocket": websocket,
		"@graftland/plugin-remote/runner/auth/none": none,
		"@graftland/plugin-remote/runner/auth/bearer": bearer,
		"@example/auth": header,
		...additional,
	})
const session = Effect.fnUntraced(function* (port: number, token?: string) {
	const url = new URL(`ws://127.0.0.1:${port}`)
	const channel = yield* connector({ url: url.href }, properties(url)).connect(
		token === undefined
			? { _tag: "None" }
			: { _tag: "Authorization", value: Redacted.make(`Bearer ${token}`) },
	)
	const mux = yield* Multiplex.make(channel)
	const portProtocol = yield* Port.make(Wire.channel(mux, 0), {
		session: "session-v1",
		serve: {},
		call: { session: Wire.Session },
	})
	return yield* RpcClient.make(Wire.Session).pipe(
		Effect.provideService(
			RpcClient.Protocol,
			portProtocol.clientProtocol("session"),
		),
	)
})
const open = (
	client: Effect.Success<ReturnType<typeof session>>,
	requestId: string,
) =>
	client.Open({
		instance: "worker",
		expectedGeneration: null,
		requestId,
		limits: defaults,
	})
const find = (
	trees: ReadonlyArray<Fork.ForkTree>,
	name: string,
): Option.Option<Fork.ForkTree> =>
	Array.findFirst(trees, (tree) =>
		tree.name === name ? Option.some(tree) : find(tree.children, name),
	)
const snapshot = (name: string) =>
	Graft.forks.pipe(
		Stream.map((trees) => find(trees, name)),
		Stream.filter(Option.isSome),
		Stream.map((tree) => tree.value),
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
	)

it.live(
	"keeps the supervisor and another listener running after a listener fails",
	() =>
		Effect.gen(function* () {
			const fail = yield* Deferred.make<void>()
			const closed = yield* Deferred.make<void>()
			const broken = Plugin.make({
				name: "test-failing-listener",
				inject: [Supervisor],
				apply: () =>
					Graft.provide(Listener, {
						properties: {
							protocol: "test",
							encrypted: false,
							network: false,
							carries: [],
						},
						bind: Effect.fnUntraced(function* () {
							const started = yield* Deferred.make<void>()
							yield* Effect.acquireRelease(Effect.void, () =>
								Deferred.succeed(closed, undefined),
							)
							return {
								ready: Deferred.await(started),
								serve: () =>
									Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Deferred.await(fail)),
										Effect.andThen(
											Effect.fail(
												TransportError.make({
													cause: Cause.die(new Error("Listener stopped")),
												}),
											),
										),
									),
							}
						}),
					}),
			})
			return yield* Effect.gen(function* () {
				const modules = yield* ModuleResolver.ModuleResolver
				yield* Graft.provide(ModuleResolver.ModuleResolver, modules)
				const fs = yield* FileSystem.FileSystem
				const state = yield* fs.makeTempDirectoryScoped()
				const port = yield* availablePort
				const owner = yield* Graft.plugin(runner, {
					state,
					root: inject("remoteRoot"),
					listen: [
						{ transport: { name: "@example/broken", config: {} } },
						{ url: `ws://127.0.0.1:${port}` },
					],
				})
				yield* owner.await
				const engine = yield* snapshot("remote-supervisor")
				const client = yield* session(port)
				const record = yield* open(client, "before-failure")
				yield* Deferred.succeed(fail, undefined)
				yield* Deferred.await(closed)
				const failed = yield* Graft.forks.pipe(
					Stream.map((trees) => find(trees, "remote-assembly")),
					Stream.filter(
						(tree) => Option.isSome(tree) && tree.value.state._tag === "Failed",
					),
					Stream.runHead,
				)
				assert.isTrue(Option.isSome(failed))
				const next = yield* session(port)
				const generation = yield* next.HighWater({ instance: "worker" })
				assert.equal(generation, record.handle.generation)
				yield* next.Renew(record.handle)
				const after = yield* snapshot("remote-supervisor")
				assert.equal(after.id, engine.id)
				assert.equal(after.state._tag, "Active")
				const active = yield* Stream.runHead(owner.state)
				assert.equal(Option.getOrThrow(active)._tag, "Active")
				yield* next.Dispose(record.handle)
			}).pipe(Effect.provide(resolver({ "@example/broken": broken })))
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("rejects two issuers before binding any listener", () =>
	Effect.gen(function* () {
		const bound = yield* Deferred.make<void>()
		const listener = Plugin.service(
			Listener,
			Effect.succeed({
				properties: {
					protocol: "test",
					encrypted: true,
					network: false,
					carries: ["header"],
				},
				bind: () =>
					Deferred.succeed(bound, undefined).pipe(
						Effect.as({ ready: Effect.void, serve: () => Effect.never }),
					),
			}),
			{ name: "test-unbound-listener" },
		)
		return yield* Effect.gen(function* () {
			const modules = yield* ModuleResolver.ModuleResolver
			yield* Graft.provide(ModuleResolver.ModuleResolver, modules)
			const fs = yield* FileSystem.FileSystem
			const state = yield* fs.makeTempDirectoryScoped()
			const fork = yield* Graft.plugin(runner, {
				state,
				root: inject("remoteRoot"),
				listen: Array.map(["one", "two"], (issuer) => ({
					transport: { name: "@example/listener", config: {} },
					auth: {
						name: "@example/auth",
						config: { issuer, token: "fixture", identity: "host" },
					},
				})),
			})
			const result = yield* Effect.exit(fork.await)
			assert.equal(result._tag, "Failure")
			if (result._tag === "Failure")
				assert.include(
					Cause.pretty(result.cause),
					"single authentication issuer",
				)
			const opened = yield* Deferred.isDone(bound)
			assert.isFalse(opened)
		}).pipe(Effect.provide(resolver({ "@example/listener": listener })))
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("loads a third-party Header authenticator by name and config", () =>
	Effect.gen(function* () {
		const modules = yield* ModuleResolver.ModuleResolver
		yield* Graft.provide(ModuleResolver.ModuleResolver, modules)
		const fs = yield* FileSystem.FileSystem
		const state = yield* fs.makeTempDirectoryScoped()
		const port = yield* availablePort
		const fork = yield* Graft.plugin(runner, {
			state,
			root: inject("remoteRoot"),
			listen: [
				{
					url: `ws://127.0.0.1:${port}`,
					auth: {
						name: "@example/auth",
						config: {
							issuer: "https://issuer.example",
							token: "fixture",
							identity: "third-party-host",
						},
					},
				},
			],
		})
		yield* fork.await
		const client = yield* session(port, "fixture")
		const record = yield* open(client, "third-party")
		assert.equal(record.handle.key.identity, "third-party-host")
		assert.equal(record.handle.generation, 1)
		const stopped = yield* client.Dispose(record.handle)
		assert.equal(stopped.kind, "Exited")
	}).pipe(Effect.scoped, Effect.provide(Layer.merge(runtime, resolver()))),
)

it.live(
	"closes listeners that were ready when another listener fails at startup",
	() =>
		Effect.gen(function* () {
			const bound = yield* Deferred.make<void>()
			const closed = yield* Deferred.make<void>()
			const waiting = Plugin.service(
				Listener,
				Effect.succeed({
					properties: {
						protocol: "test",
						encrypted: false,
						network: false,
						carries: [],
					},
					bind: Effect.fnUntraced(function* () {
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(closed, undefined),
						)
						return {
							ready: Deferred.succeed(bound, undefined).pipe(Effect.asVoid),
							serve: () => Effect.never,
						}
					}),
				}),
				{ name: "test-ready-listener" },
			)
			const failing = Plugin.service(
				Listener,
				Effect.succeed({
					properties: {
						protocol: "test",
						encrypted: false,
						network: false,
						carries: [],
					},
					bind: () =>
						Deferred.await(bound).pipe(
							Effect.andThen(
								Effect.fail(
									TransportError.make({
										cause: Cause.die(new Error("Binding failed")),
									}),
								),
							),
						),
				}),
				{ name: "test-startup-failure" },
			)
			return yield* Effect.gen(function* () {
				const modules = yield* ModuleResolver.ModuleResolver
				yield* Graft.provide(ModuleResolver.ModuleResolver, modules)
				const fs = yield* FileSystem.FileSystem
				const state = yield* fs.makeTempDirectoryScoped()
				const fork = yield* Graft.plugin(runner, {
					state,
					root: inject("remoteRoot"),
					listen: [
						{ transport: { name: "@example/waiting", config: {} } },
						{ transport: { name: "@example/failing", config: {} } },
					],
				})
				const result = yield* Effect.exit(fork.await)
				assert.equal(result._tag, "Failure")
				if (result._tag === "Failure")
					assert.include(Cause.pretty(result.cause), "Binding failed")
				yield* Deferred.await(closed)
			}).pipe(
				Effect.provide(
					resolver({
						"@example/waiting": waiting,
						"@example/failing": failing,
					}),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("starts two bearer listeners with different token files", () =>
	Effect.gen(function* () {
		const modules = yield* ModuleResolver.ModuleResolver
		yield* Graft.provide(ModuleResolver.ModuleResolver, modules)
		const fs = yield* FileSystem.FileSystem
		const digest = yield* Digest.Digest
		const directory = yield* fs.makeTempDirectoryScoped()
		const listeners = yield* Effect.forEach(
			["one", "two"],
			Effect.fnUntraced(function* (identity) {
				const token = "token-" + identity
				const hash = yield* digest.digestHex(
					Digest.sha256,
					new TextEncoder().encode(token),
				)
				const tokens = directory + "/" + identity + ".json"
				const json = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
				)({ [hash]: identity })
				yield* fs.writeFileString(tokens, json)
				const port = yield* availablePort
				return { identity, token, tokens, port }
			}),
		)
		const fork = yield* Graft.plugin(runner, {
			state: directory + "/state",
			root: inject("remoteRoot"),
			listen: Array.map(listeners, ({ port, tokens }) => ({
				url: `ws://127.0.0.1:${port}`,
				auth: { bearer: { tokens } },
			})),
		})
		yield* fork.await
		yield* Effect.forEach(listeners, ({ port, token, identity }) =>
			Effect.scoped(
				Effect.gen(function* () {
					const client = yield* session(port, token)
					const record = yield* open(client, identity)
					assert.equal(record.handle.key.identity, identity)
					const stopped = yield* client.Dispose(record.handle)
					assert.equal(stopped.kind, "Exited")
				}),
			),
		)
	}).pipe(Effect.scoped, Effect.provide(Layer.merge(runtime, resolver()))),
)
