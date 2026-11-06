import {
	Array,
	Context,
	Effect,
	FileSystem,
	Layer,
	Schema,
	Scope,
} from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Catalog from "../src/Catalog.ts"
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
type Item = Parameters<McpServer.McpServer["Service"]["addTool"]>[0]
const kind: Catalog.Kind<Item> = {
	key: "@acme/graft-plugin-input/Tools/kind",
	list: "tools",
	identities: (item) => [item.tool.name],
	install: (item, annotations) =>
		McpServer.McpServer.use((server) =>
			server.addTool({
				...item,
				annotations: Catalog.enabledWhen(annotations, item.annotations),
			}),
		),
}
for (const [name, transport] of [
	["Testing", Testing.transport],
	["stdio", stdioTransport],
	["Unix", unixTransport],
	["HTTP", httpTransport],
] as const) {
	it.effect(
		name +
			": a public low-level kind supports MRTR, capability errors and icons",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "test/input",
						apply: () =>
							Effect.gen(function* () {
								const handle = yield* Catalog.own(() =>
									McpSchema.McpRequestContext.use((context) =>
										Effect.succeed(
											context.inputResponses?.["answer"] === undefined
												? new McpSchema.InputRequired({
														inputRequests: {
															answer: { method: "roots/list", params: {} },
														},
														requestState: "opaque",
													})
												: McpSchema.CallToolResult.make({
														content: [
															{
																type: "text",
																text: context.requestState ?? "missing",
															},
														],
													}),
										),
									),
								)
								yield* Catalog.offer(kind, {
									tool: McpSchema.Tool.make({
										name: "input",
										icons: [{ src: "https://example.com/icon.png" }],
										inputSchema: { type: "object" },
									}),
									annotations: Context.empty(),
									handle,
								})
							}),
					}),
				)).await
				const adapter = yield* transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "input", arguments: {}, _meta: Testing.metadata },
				})
				const missing = yield* Testing.response(client, 1)
				// MCP 2026-07-28: capability_required, Effect internal/mcpProtocol/v2026_07_28.ts.
				assert.equal(missing.error?.code, -32021)
				const metadata = {
					...Testing.metadata,
					"io.modelcontextprotocol/clientCapabilities": { roots: {} },
				}
				yield* client.send({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "input", arguments: {}, _meta: metadata },
				})
				const input = yield* Testing.response(client, 2)
				assert.include(input.result, {
					resultType: "input_required",
					requestState: "opaque",
				})
				yield* client.send({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "input",
						arguments: {},
						inputResponses: { answer: { roots: [] } },
						requestState: "opaque",
						_meta: metadata,
					},
				})
				const complete = yield* Testing.response(client, 3)
				assert.include(complete.result, { resultType: "complete" })
				yield* client.send({
					jsonrpc: "2.0",
					id: 4,
					method: "tools/list",
					params: { _meta: metadata },
				})
				const list = yield* Testing.response(client, 4)
				assert.deepInclude(
					(list.result as { tools: ReadonlyArray<unknown> }).tools[0],
					{ icons: [{ src: "https://example.com/icon.png" }] },
				)
			}).pipe(run),
	)

	it.effect(
		name + ": modern progress and logs are filtered by request metadata",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const kit = Toolkit.make(
					Tool.make("report", {
						success: Schema.Void,
						dependencies: [McpServer.McpServer, McpSchema.McpRequestContext],
					}),
				)
				yield* (yield* Graft.plugin(
					Tools.plugin({
						name: "test/report",
						toolkit: kit,
						handlers: Effect.succeed(
							kit.of({
								report: () =>
									Effect.gen(function* () {
										const server = yield* McpServer.McpServer
										yield* server.notifications["notifications/progress"]({
											progressToken: "token",
											progress: 1,
										})
										yield* server.notifications["notifications/message"]({
											level: "info",
											data: "report",
										})
									}),
							}),
						),
					}),
				)).await
				const adapter = yield* transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				for (const enabled of [false, true]) {
					yield* client.send({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name: "report",
							arguments: {},
							_meta: {
								...Testing.metadata,
								...(enabled
									? {
											progressToken: "token",
											"io.modelcontextprotocol/logLevel": "info",
										}
									: {}),
							},
						},
					})
					let methods: ReadonlyArray<string> = []
					while (true) {
						const message = yield* client.receive
						if (!("method" in message)) {
							assert.isUndefined(message.error)
							break
						}
						methods = [...methods, message.method]
					}
					assert.equal(
						Array.contains(methods, "notifications/progress"),
						enabled,
					)
					assert.equal(
						Array.contains(methods, "notifications/message"),
						enabled,
					)
				}
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
		name +
			": input requests enforce sampling tools and form or URL elicitation capabilities",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const cases: ReadonlyArray<{
					name: string
					request: NonNullable<McpSchema.InputRequired["inputRequests"]>[string]
					capabilities: Record<string, unknown>
				}> = [
					{
						name: "sampling",
						request: {
							method: "sampling/createMessage",
							params: {
								messages: [
									{ role: "user", content: { type: "text", text: "Hello" } },
								],
								maxTokens: 10,
								tools: [{ name: "echo", inputSchema: { type: "object" } }],
							},
						},
						capabilities: { sampling: { tools: {} } },
					},
					{
						name: "form",
						request: {
							method: "elicitation/create",
							params: {
								mode: "form",
								message: "Name?",
								requestedSchema: {
									type: "object",
									properties: { name: { type: "string" } },
									required: ["name"],
								},
							},
						},
						capabilities: { elicitation: { form: {} } },
					},
					{
						name: "url",
						request: {
							method: "elicitation/create",
							params: {
								mode: "url",
								message: "Sign in",
								elicitationId: "signin",
								url: "https://example.com/sign-in",
							},
						},
						capabilities: { elicitation: { url: {} } },
					},
				]
				for (const sample of cases)
					yield* (yield* Graft.plugin(
						Plugin.make({
							name: "test/input/" + sample.name,
							apply: () =>
								Effect.gen(function* () {
									const handle = yield* Catalog.own(() =>
										Effect.succeed(
											new McpSchema.InputRequired({
												inputRequests: { answer: sample.request },
											}),
										),
									)
									yield* Catalog.offer(kind, {
										tool: McpSchema.Tool.make({
											name: sample.name,
											inputSchema: { type: "object" },
										}),
										annotations: Context.empty(),
										handle,
									})
								}),
						}),
					)).await
				const adapter = yield* transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				for (const sample of cases) {
					yield* client.send({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name: sample.name,
							arguments: {},
							_meta: {
								...Testing.metadata,
								"io.modelcontextprotocol/clientCapabilities": { sampling: {} },
							},
						},
					})
					const rejected = yield* Testing.response(client, 1)
					assert.equal(rejected.error?.code, -32021)
					yield* client.send({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: {
							name: sample.name,
							arguments: {},
							_meta: {
								...Testing.metadata,
								"io.modelcontextprotocol/clientCapabilities":
									sample.capabilities,
							},
						},
					})
					const allowed = yield* Testing.response(client, 2)
					assert.propertyVal(allowed.result, "resultType", "input_required")
				}
			}).pipe(run),
	)
}
