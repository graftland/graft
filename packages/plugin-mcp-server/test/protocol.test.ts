import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Schema,
	Scope,
} from "effect"
import { McpSchema, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import core from "../src/index.ts"
import * as Prompts from "../src/Prompts.ts"
import * as Resources from "../src/Resources.ts"
import { Server } from "../src/Server.ts"
import * as Testing from "../src/Testing.ts"
import * as Tools from "../src/Tools.ts"
import { httpTransport } from "./http-support.ts"
import { stdioTransport, unixTransport } from "./wire.ts"

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| HttpClient.HttpClient
		| Graft.Graft
		| Scope.Scope
		| import("effect").FileSystem.FileSystem
	>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Layer.merge(Layer.fresh(Graft.layer), NodeServices.layer),
				FetchHttpClient.layer,
			),
		),
	)

for (const [name, transport] of [
	["Testing", Testing.transport],
	["stdio", stdioTransport],
	["Unix", unixTransport],
	["HTTP", httpTransport],
] as const) {
	it.effect(
		name +
			": discovery, metadata errors, cache hints, tools, resources and prompts",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {
					name: "wire",
					version: "2.0.0",
					description: "Wire test",
					cache: { tools: { ttl: "100" } },
				})).await
				const adapter = yield* transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "server/discover",
					params: { _meta: Testing.metadata },
				})
				const discovery = yield* Testing.response(client, 1)
				assert.property(discovery, "result")
				assert.include(discovery.result, { resultType: "complete" })
				yield* client.send({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
					params: {
						_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
					},
				})
				assert.equal(
					(yield* Testing.response(client, 2)).error?.code,
					McpSchema.INVALID_PARAMS_ERROR_CODE,
				)
				yield* client.send({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/list",
					params: {
						_meta: {
							...Testing.metadata,
							"io.modelcontextprotocol/protocolVersion": "2099-01-01",
						},
					},
				})
				assert.equal(
					(yield* Testing.response(client, 3)).error?.code,
					McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
				)
				const kit = Toolkit.make(
					Tool.make("echo", {
						parameters: Schema.Struct({ text: Schema.String }),
						success: Schema.String,
					}),
				)
				yield* (yield* Graft.plugin(
					Tools.plugin({
						name: "test/echo",
						toolkit: kit,
						handlers: Effect.succeed(
							kit.of({ echo: ({ text }) => Effect.succeed(text) }),
						),
					}),
				)).await
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "test/content",
						apply: () =>
							Effect.gen(function* () {
								yield* Resources.offer({
									name: "entry",
									uri: "note://entry",
									content: Effect.succeed("entry"),
								})
								yield* Prompts.offer({
									name: "greet",
									content: () => Effect.succeed("Hello"),
								})
							}),
					}),
				)).await
				for (const [id, method, params] of [
					[4, "tools/call", { name: "echo", arguments: { text: "hello" } }],
					[5, "resources/read", { uri: "note://entry" }],
					[6, "prompts/get", { name: "greet" }],
					[7, "tools/list", {}],
				] as const) {
					yield* client.send({
						jsonrpc: "2.0",
						id,
						method,
						params: { ...params, _meta: Testing.metadata },
					})
					const result = yield* Testing.response(client, id)
					assert.property(result, "result")
					assert.include(result.result, { resultType: "complete" })
				}
			}).pipe(run),
	)

	it.effect(
		name + ": early listen receives later prompts and resource updates",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const adapter = yield* transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				yield* client.send({
					jsonrpc: "2.0",
					id: 10,
					method: "subscriptions/listen",
					params: {
						notifications: {
							promptsListChanged: true,
							resourceSubscriptions: ["note://entry"],
						},
						_meta: Testing.metadata,
					},
				})
				const ack = yield* client.receive
				assert.propertyVal(
					ack,
					"method",
					"notifications/subscriptions/acknowledged",
				)
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "test/prompt",
						apply: () =>
							Prompts.offer({
								name: "late",
								content: () => Effect.succeed("late"),
							}),
					}),
				)).await
				const changed = yield* client.receive
				assert.propertyVal(
					changed,
					"method",
					"notifications/prompts/list_changed",
				)
				yield* Resources.updated("note://entry")
				const updated = yield* client.receive
				assert.propertyVal(updated, "method", "notifications/resources/updated")
				if ("params" in updated)
					assert.deepInclude(updated.params, {
						uri: "note://entry",
						_meta: { "io.modelcontextprotocol/subscriptionId": 10 },
					})
			}).pipe(run),
	)
	it.effect(name + ": transport conformance", () =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, { protocols: ["2026-07-28"] })).await
			const adapter = yield* transport
			yield* Testing.transportConformance(adapter.plugin, adapter.client, {
				name: "graft",
				version: "0.0.0",
				protocols: ["2026-07-28"],
			})
		}).pipe(run),
	)
}

for (const [name, transport] of [
	["Testing", Testing.transport],
	["stdio", stdioTransport],
	["Unix", unixTransport],
	["HTTP", httpTransport],
] as const) {
	it.effect(name + ": resource kind conformance", () =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const adapter = yield* transport
			yield* (yield* Graft.plugin(adapter.plugin)).await
			const client = yield* adapter.client
			const sample = {
				name: "conformance",
				uri: "test://kind",
				content: Effect.succeed("content"),
			}
			const inspect = Effect.gen(function* () {
				yield* client.send({
					jsonrpc: "2.0",
					id: 42,
					method: "resources/list",
					params: { _meta: Testing.metadata },
				})
				const reply = yield* Testing.response(client, 42)
				return Array.map(
					(reply.result as { resources: ReadonlyArray<{ uri: string }> })
						.resources,
					(item) => item.uri,
				)
			})
			yield* Testing.kindConformance(Resources.kind, sample, inspect, {
				...sample,
				annotations: Context.make(McpSchema.EnabledWhen, () => false),
			})
		}).pipe(run),
	)
}

for (const [name, transport] of [
	["Testing", Testing.transport],
	["stdio", stdioTransport],
	["Unix", unixTransport],
	["HTTP", httpTransport],
] as const) {
	it.effect(
		name + ": honors protocol filtering and stops when Server is withdrawn",
		() =>
			Effect.gen(function* () {
				const server = yield* Graft.plugin(core, { protocols: ["2026-07-28"] })
				yield* server.await
				const adapter = yield* transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						clientInfo: { name: "legacy", version: "1" },
						capabilities: {},
					},
				})
				const rejected = yield* Testing.response(client, 1)
				assert.equal(
					rejected.error?.code,
					// Effect's modern-only HTTP admission rejects an unversioned legacy POST before initialize dispatch.
					name === "HTTP"
						? McpSchema.HEADER_MISMATCH_ERROR_CODE
						: McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
				)
				yield* client.send({
					jsonrpc: "2.0",
					id: 2,
					method: "server/discover",
					params: { _meta: Testing.metadata },
				})
				const discovered = yield* Testing.response(client, 2)
				assert.deepStrictEqual(
					(discovered.result as { supportedVersions: ReadonlyArray<string> })
						.supportedVersions,
					["2026-07-28"],
				)
				yield* server.dispose
				yield* client.closed
			}).pipe(run),
	)
}

for (const [name, transport] of [
	["Testing", Testing.transport],
	["stdio", stdioTransport],
	["Unix", unixTransport],
	["HTTP", httpTransport],
] as const) {
	it.effect(
		name + ": conformance with a filtered core and dependency shutdown",
		() =>
			Effect.gen(function* () {
				const server = yield* Graft.plugin(core, { protocols: ["2026-07-28"] })
				yield* server.await
				const adapter = yield* transport
				const closed = yield* Deferred.make<void>()
				yield* Testing.transportConformance(adapter.plugin, adapter.client, {
					name: "graft",
					version: "0.0.0",
					protocols: ["2026-07-28"],
					close: server.dispose.pipe(
						Effect.orDie,
						Effect.andThen(Deferred.succeed(closed, undefined)),
						Effect.asVoid,
					),
				})
				const wasClosed = yield* Deferred.isDone(closed)
				assert.isTrue(wasClosed)
			}).pipe(run),
	)
}

it.effect(
	"one request emits resource updates to Testing, stdio and Unix without carrying its request context",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const clients: ReadonlyArray<Testing.Connection> = yield* Effect.forEach(
				[Testing.transport, stdioTransport, unixTransport],
				(adapter) =>
					Effect.gen(function* () {
						const current = yield* adapter
						yield* (yield* Graft.plugin(current.plugin)).await
						return yield* current.client
					}),
			)
			for (const [index, client] of clients.entries()) {
				yield* client.send({
					jsonrpc: "2.0",
					id: index + 10,
					method: "subscriptions/listen",
					params: {
						_meta: Testing.metadata,
						notifications: {
							resourceSubscriptions: ["test://fanout"],
							toolsListChanged: true,
						},
					},
				})
				const ack = yield* client.receive
				assert.propertyVal(
					ack,
					"method",
					"notifications/subscriptions/acknowledged",
				)
			}
			const kit = Toolkit.make(
				Tool.make("notify", {
					success: Schema.Void,
					dependencies: [Graft.Graft],
				}),
			)
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/fanout",
					apply: () =>
						Tools.offer(
							kit,
							kit.of({ notify: () => Resources.updated("test://fanout") }),
						),
				}),
			)).await
			for (const client of clients) {
				const change = yield* client.receive
				assert.propertyVal(change, "method", "notifications/tools/list_changed")
			}
			yield* clients[0]!.send({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { _meta: Testing.metadata, name: "notify", arguments: {} },
			})
			for (const [index, client] of clients.entries()) {
				let update = yield* client.receive
				if (!("method" in update)) update = yield* client.receive
				assert.propertyVal(update, "method", "notifications/resources/updated")
				if ("method" in update)
					assert.deepStrictEqual(update.params?.["_meta"], {
						"io.modelcontextprotocol/subscriptionId": index + 10,
					})
			}
		}).pipe(run),
)

for (const [name, transport] of [
	["Testing", Testing.transport],
	["stdio", stdioTransport],
	["Unix", unixTransport],
	["HTTP", httpTransport],
] as const) {
	it.effect(name + ": modern and legacy requests share one connection", () =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const adapter = yield* transport
			yield* (yield* Graft.plugin(adapter.plugin)).await
			const client = yield* adapter.client
			yield* client.send({
				jsonrpc: "2.0",
				id: 1,
				method: "server/discover",
				params: { _meta: Testing.metadata },
			})
			const discovered = yield* Testing.response(client, 1)
			assert.property(discovered, "result")
			yield* client.send({
				jsonrpc: "2.0",
				id: 2,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "legacy", version: "1" },
				},
			})
			assert.propertyVal(
				(yield* Testing.response(client, 2)).result,
				"protocolVersion",
				"2025-11-25",
			)
			yield* client.send({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			})
			yield* client.send({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/list",
				params: {},
			})
			assert.deepStrictEqual((yield* Testing.response(client, 3)).result, {
				tools: [],
			})
			yield* client.send({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/list",
				params: { _meta: Testing.metadata },
			})
			assert.propertyVal(
				(yield* Testing.response(client, 4)).result,
				"resultType",
				"complete",
			)
		}).pipe(run),
	)
}

for (const closeTimeout of [undefined, "1 second"] as const)
	it.effect(
		"the transport kit bounds stale Server closure with " +
			(closeTimeout ?? "the default timeout"),
		() =>
			Effect.gen(function* () {
				const server = yield* Graft.plugin(core, { protocols: ["2026-07-28"] })
				yield* server.await
				const captured = yield* Deferred.make<Server["Service"]>()
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "test/capture-server",
						inject: [Server],
						apply: () =>
							Effect.flatMap(Server, (service) =>
								Deferred.succeed(captured, service).pipe(Effect.asVoid),
							),
					}),
				)).await
				const stale = yield* Deferred.await(captured)
				const adapter = yield* Testing.transport
				const broken = Plugin.make({
					name: "test/stale-transport",
					apply: () =>
						Effect.gen(function* () {
							yield* Graft.provide(Server, stale)
							yield* (yield* Graft.plugin(adapter.plugin)).await
						}),
				})
				// Keep the stale provider in its own realm so withdrawing the real core cannot stop it.
				const wrapper = Plugin.make({
					name: "test/broken-transport-wrapper",
					apply: () =>
						Effect.gen(function* () {
							yield* (yield* Graft.plugin(broken, undefined, {
								isolate: [Server],
							})).await
						}),
				})
				const closed = yield* Deferred.make<void>()
				const checked = yield* Testing.transportConformance(
					wrapper,
					adapter.client,
					{
						...(closeTimeout === undefined ? {} : { closeTimeout }),
						name: "graft",
						version: "0.0.0",
						protocols: ["2026-07-28"],
						close: server.dispose.pipe(
							Effect.orDie,
							Effect.andThen(Deferred.succeed(closed, undefined)),
							Effect.asVoid,
						),
					},
				).pipe(Effect.exit, Effect.forkScoped)
				yield* Deferred.await(closed)
				const client = yield* adapter.client
				yield* client.send({
					jsonrpc: "2.0",
					id: 99,
					method: "tools/list",
					params: { _meta: Testing.metadata },
				})
				const stillServing = yield* Testing.response(client, 99)
				assert.isUndefined(stillServing.error)
				yield* TestClock.adjust(closeTimeout ?? "5 seconds")
				const outcome = yield* Fiber.join(checked)
				assert.isTrue(Exit.isFailure(outcome))
				if (Exit.isFailure(outcome))
					assert.include(
						Cause.pretty(outcome.cause),
						"transport did not stop serving after close within closeTimeout",
					)
			}).pipe(run),
	)
