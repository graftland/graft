import {
	Array,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Ref,
	Schema,
	Scope,
} from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import core from "../src/index.ts"
import * as Testing from "../src/Testing.ts"
import * as Tools from "../src/Tools.ts"
import { httpTransport } from "./http-support.ts"
import { stdioTransport, unixTransport } from "./wire.ts"

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		HttpClient.HttpClient | Graft.Graft | Scope.Scope | FileSystem.FileSystem
	>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Layer.merge(Graft.layer, NodeServices.layer),
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
		name + ": legacy reverse APIs and per-request metadata use Effect directly",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const kit = Toolkit.make(
					Tool.make("client", {
						success: Schema.String,
						dependencies: [
							McpSchema.McpServerClient,
							McpSchema.McpRequestContext,
							McpServer.McpServer,
							Scope.Scope,
						],
					}),
				)
				yield* (yield* Graft.plugin(
					Tools.plugin({
						name: "test/client-api",
						toolkit: kit,
						handlers: Effect.succeed(
							kit.of({
								client: () =>
									Effect.gen(function* () {
										const context = yield* McpSchema.McpRequestContext
										assert.equal(context.requestMetadata?.["marker"], "call")
										const server = yield* McpServer.McpServer
										yield* server.notifications["notifications/progress"]({
											progressToken: "call-token",
											progress: 1,
											total: 2,
										})
										yield* server.notifications["notifications/message"]({
											level: "info",
											data: "protocol log",
										})
										const form = yield* McpServer.elicit({
											message: "Your name?",
											schema: Schema.Struct({ name: Schema.String }),
										})
										const client = yield* (yield* McpSchema.McpServerClient)
											.getClient
										yield* client
											.elicit(
												McpSchema.ElicitRequestURLParams.make({
													mode: "url",
													message: "Sign in",
													url: "https://example.com/sign-in",
													elicitationId: "signin",
												}),
											)
											.pipe(Effect.orDie)
										yield* server.notifyElicitationComplete({
											clientId: context.clientId,
											elicitationId: "signin",
										})
										yield* client
											.createMessage({
												messages: [
													{
														role: "user",
														content: { type: "text", text: "Hello" },
													},
												],
												maxTokens: 20,
											})
											.pipe(Effect.orDie)
										const roots = yield* client.listRoots({}).pipe(Effect.orDie)
										return form.name + ":" + roots.roots.length
									}).pipe(
										Effect.catchTag("ElicitationDeclined", () =>
											Effect.succeed("declined"),
										),
									),
							}),
						),
					}),
				)).await
				const adapter = yield* transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						clientInfo: { name: "test", version: "1" },
						capabilities: {
							elicitation: { form: {}, url: {} },
							sampling: {},
							roots: {},
						},
						_meta: { marker: "initialize" },
					},
				})
				const initialized = yield* Testing.response(client, 1)
				assert.property(initialized, "result")
				yield* client.send({
					jsonrpc: "2.0",
					method: "notifications/initialized",
					params: {},
				})
				yield* client.send({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: {
						name: "client",
						arguments: {},
						_meta: { marker: "call", progressToken: "call-token" },
					},
				})
				let methods: ReadonlyArray<string> = []
				while (true) {
					const message = yield* client.receive
					if (!("method" in message)) {
						if (message.id === 2) {
							assert.isUndefined(message.error)
							assert.equal(
								(message.result as { content: ReadonlyArray<{ text: string }> })
									.content[0]?.text,
								"Ada:1",
							)
							break
						}
						continue
					}
					methods = [...methods, message.method]
					if (!("id" in message)) continue
					const result =
						message.method === "elicitation/create"
							? { action: "accept", content: { name: "Ada" } }
							: message.method === "roots/list"
								? { roots: [{ uri: "file:///notes", name: "Notes" }] }
								: {
										role: "assistant",
										content: { type: "text", text: "Hello" },
										model: "test",
										stopReason: "endTurn",
									}
					yield* client.send({ jsonrpc: "2.0", id: message.id, result })
				}
				for (const method of [
					"notifications/progress",
					"notifications/message",
					"elicitation/create",
					"notifications/elicitation/complete",
					"sampling/createMessage",
					"roots/list",
				])
					assert.isTrue(Array.contains(methods, method))
			}).pipe(run),
	)
}

for (const [name, transport] of [
	["Testing", Testing.transport],
	["stdio", stdioTransport],
	["Unix", unixTransport],
	["HTTP", httpTransport],
] as const) {
	for (const action of ["decline", "cancel"] as const) {
		it.effect(
			name +
				": legacy form elicitation " +
				action +
				" preserves Effect semantics",
			() =>
				Effect.gen(function* () {
					yield* (yield* Graft.plugin(core, {})).await
					const stopped = yield* Deferred.make<void>()
					const continued = yield* Ref.make(false)
					const kit = Toolkit.make(
						Tool.make("form", {
							success: Schema.String,
							dependencies: [McpSchema.McpServerClient],
						}),
					)
					yield* (yield* Graft.plugin(
						Tools.plugin({
							name: "test/form",
							toolkit: kit,
							handlers: Effect.succeed(
								kit.of({
									form: () =>
										McpServer.elicit({
											message: "Name?",
											schema: Schema.Struct({ name: Schema.String }),
										}).pipe(
											Effect.andThen(Ref.set(continued, true)),
											Effect.as("accepted"),
											Effect.catchTag("ElicitationDeclined", () =>
												Effect.succeed("declined"),
											),
											Effect.ensuring(Deferred.succeed(stopped, undefined)),
										),
								}),
							),
						}),
					)).await
					const adapter = yield* transport
					yield* (yield* Graft.plugin(adapter.plugin)).await
					const client = yield* adapter.client
					yield* client.send({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-11-25",
							capabilities: { elicitation: { form: {} } },
							clientInfo: { name: "test", version: "1" },
						},
					})
					yield* Testing.response(client, 1)
					yield* client.send({
						jsonrpc: "2.0",
						method: "notifications/initialized",
						params: {},
					})
					yield* client.send({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "form", arguments: {} },
					})
					const request = yield* client.receive
					assert.propertyVal(request, "method", "elicitation/create")
					if (
						!("id" in request) ||
						request.id === null ||
						request.id === undefined
					)
						return yield* Effect.die("Expected a reverse request id")
					yield* client.send({
						jsonrpc: "2.0",
						id: request.id,
						result: { action },
					})
					yield* Deferred.await(stopped)
					const accepted = yield* Ref.get(continued)
					assert.isFalse(accepted)
					if (action === "decline") {
						const result = yield* Testing.response(client, 2)
						assert.deepStrictEqual(result.result, {
							content: [{ type: "text", text: "declined" }],
							isError: false,
						})
					}
				}).pipe(run),
		)
	}
}
