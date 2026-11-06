import {
	Array,
	Context,
	Effect,
	Redacted,
	Ref,
	Schema,
	SubscriptionRef,
} from "effect"
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpClient } from "effect/http"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"
import {
	InvalidToken,
	Principal,
	TokenValidator,
} from "@graftland/plugin-http/Authorization"
import * as Http from "@graftland/plugin-http/Http"
import oauth from "@graftland/plugin-http/oauth"

import * as Catalog from "../src/Catalog.ts"
import http from "../src/http.ts"
import core from "../src/index.ts"
import * as Middleware from "../src/Middleware.ts"
import * as Prompts from "../src/Prompts.ts"
import * as Resources from "../src/Resources.ts"
import { isolate, Server } from "../src/Server.ts"
import * as Testing from "../src/Testing.ts"
import * as Tools from "../src/Tools.ts"
import {
	adapter,
	capture,
	connection,
	headers,
	mcpClient,
	names,
	post,
	rpc,
	run,
	start,
} from "./http-support.ts"
import { stdioTransport } from "./wire.ts"

const contributor = (name: string) => {
	const toolkit = Toolkit.make(Tool.make(name, { success: Schema.String }))
	return Tools.plugin({
		name: "test/http/" + name,
		toolkit,
		handlers: Effect.succeed(
			toolkit.of({ [name]: () => Effect.succeed(name) }),
		),
	})
}
for (const close of [false, true])
	it.live(
		"HTTP transport conformance: " +
			(close ? "Server withdrawal" : "input closure"),
		() =>
			Effect.gen(function* () {
				const { url } = yield* start
				const server = yield* Graft.plugin(core, { protocols: ["2026-07-28"] })
				yield* server.await
				const transport = adapter(url + "/mcp")
				yield* Testing.transportConformance(
					transport.plugin,
					transport.client,
					{
						name: "graft",
						version: "0.0.0",
						protocols: ["2026-07-28"],
						...(close ? { close: server.dispose.pipe(Effect.orDie) } : {}),
					},
				)
			}).pipe(run),
	)

it.live("HTTP resource kind conformance", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		yield* (yield* Graft.plugin(core, {})).await
		yield* (yield* Graft.plugin(http, {})).await
		const client = yield* mcpClient(url + "/mcp", McpProtocol.v2026_07_28)
		const item = {
			name: "entry",
			uri: "test://kind",
			content: Effect.succeed("entry"),
		}
		yield* Testing.kindConformance(
			Resources.kind,
			item,
			client
				.listResources()
				.pipe(Effect.map((items) => Array.map(items, (item) => item.uri))),
			{
				...item,
				annotations: Context.make(McpSchema.EnabledWhen, () => false),
			},
		)
	}).pipe(run),
)

for (const protocol of [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25])
	it.live(
		"HTTP public client serves tools and content on " +
			protocol.protocolVersion,
		() =>
			Effect.gen(function* () {
				const { url } = yield* start
				yield* (yield* Graft.plugin(core, {})).await
				yield* (yield* Graft.plugin(http, {})).await
				yield* (yield* Graft.plugin(contributor("echo"))).await
				const client = yield* mcpClient(url + "/mcp", protocol)
				const tools = yield* client.listTools()
				assert.deepStrictEqual(names(tools), ["echo"])
				const result = yield* client.callTool({
					tool: tools[0]!,
					arguments: {},
				})
				assert.deepStrictEqual(result.content, [
					{
						type: "text",
						text: protocol.protocolVersion === "2026-07-28" ? '"echo"' : "echo",
					},
				])
			}).pipe(run),
	)

it.live(
	"HTTP admits modern metadata and legacy sessions and rejects Origin and header mismatches",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			yield* (yield* Graft.plugin(core, {})).await
			yield* (yield* Graft.plugin(http, {
				allowedOrigins: ["https://allowed.example"],
			})).await
			const endpoint = url + "/mcp"
			const message = {
				jsonrpc: "2.0" as const,
				id: 1,
				method: "server/discover",
				params: { _meta: Testing.metadata },
			}
			const modern = yield* rpc(endpoint, "server/discover")
			assert.equal(modern.status, 200)
			assert.isUndefined(modern.headers["mcp-session-id"])
			assert.equal(
				(yield* post(endpoint, message, {
					...headers(message),
					origin: "https://evil.example",
				})).status,
				403,
			)
			assert.equal(
				(yield* rpc(
					endpoint,
					"server/discover",
					{},
					{ ...headers(message), origin: "https://allowed.example" },
				)).status,
				200,
			)
			for (const extra of [
				{ ...headers(message), "mcp-method": "tools/list" },
				{ ...headers(message), "mcp-protocol-version": "2025-11-25" },
			]) {
				const mismatch = yield* rpc(endpoint, "server/discover", {}, extra)
				assert.equal(mismatch.status, 400)
				assert.propertyVal(
					(mismatch.body as McpSchema.JsonRpcResponse).error,
					"code",
					McpSchema.HEADER_MISMATCH_ERROR_CODE,
				)
			}
			const initialized = yield* post(
				endpoint,
				{
					jsonrpc: "2.0",
					id: 2,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "legacy", version: "1" },
					},
				},
				{},
			)
			const initText = yield* initialized.text
			assert.include(initText, "2025-11-25")
			const session = initialized.headers["mcp-session-id"]!
			assert.isString(session)
			const legacyHeaders = {
				"mcp-session-id": session,
				"mcp-protocol-version": "2025-11-25",
			}
			const ready = yield* post(
				endpoint,
				{ jsonrpc: "2.0", method: "notifications/initialized", params: {} },
				legacyHeaders,
			)
			assert.equal(ready.status, 202)
			const listed = yield* post(
				endpoint,
				{ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
				legacyHeaders,
			)
			assert.equal(listed.status, 200)
			const observed0 = yield* listed.text
			assert.include(observed0, "tools")
			const mismatch = yield* post(
				endpoint,
				{ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
				{ ...legacyHeaders, "mcp-protocol-version": "2025-06-18" },
			)
			assert.equal(mismatch.status, 400)
			const observed1 = yield* mismatch.text
			assert.include(observed1, String(McpSchema.HEADER_MISMATCH_ERROR_CODE))
			const unknown = yield* post(
				endpoint,
				{ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
				{ ...legacyHeaders, "mcp-session-id": "unknown" },
			)
			assert.equal(unknown.status, 404)
			const client = yield* HttpClient.HttpClient
			assert.equal(
				(yield* client.get(endpoint, { headers: legacyHeaders })).status,
				405,
			)
			assert.equal(
				(yield* client.del(endpoint, { headers: legacyHeaders })).status,
				204,
			)
			const terminated = yield* post(
				endpoint,
				{ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
				legacyHeaders,
			)
			assert.equal(terminated.status, 404)
		}).pipe(run),
)

it.live(
	"HTTP guard is fail closed, publishes PRM and supplies the verified Principal to owned handlers",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const resource = url + "/secure"
			yield* (yield* Graft.plugin(core, {})).await
			const open = yield* Graft.plugin(http, {})
			yield* open.await
			const routes = yield* capture(Http.Routes)
			const initial = yield* SubscriptionRef.get(routes)
			const openMount = initial.served[0]
			const guarded = yield* Graft.plugin(http, {
				path: "/secure",
				authorization: { scopes: ["tools:read"] },
			})
			yield* guarded.stable
			assert.equal((yield* rpc(resource, "server/discover")).status, 404)
			const identity = {
				subject: "Alice",
				issuer: "https://issuer.example",
				audience: [resource],
				scopes: ["tools:read"],
			}
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/validator",
					apply: () =>
						Effect.gen(function* () {
							yield* Graft.provide(TokenValidator, {
								validate: (token) =>
									Redacted.value(token) === "invalid"
										? Effect.fail(
												InvalidToken.make({ cause: "invalid test token" }),
											)
										: Effect.succeed({
												...identity,
												subject:
													Redacted.value(token) === "bob" ? "Bob" : "Alice",
												scopes:
													Redacted.value(token) === "limited"
														? []
														: identity.scopes,
											}),
							})
							yield* Graft.provide(Principal, {
								...identity,
								subject: "plugin-private",
							})
						}),
				}),
			)).await
			const authorization = yield* Graft.plugin(oauth, {
				resource,
				authorizationServers: [identity.issuer],
			})
			yield* authorization.await
			yield* guarded.stable
			const unauthenticated = yield* rpc(resource, "server/discover")
			assert.equal(unauthenticated.status, 401)
			assert.include(
				unauthenticated.headers["www-authenticate"],
				'resource_metadata="' +
					url +
					'/.well-known/oauth-protected-resource/secure"',
			)
			const httpClient = yield* HttpClient.HttpClient
			const metadata = yield* httpClient.get(
				url + "/.well-known/oauth-protected-resource/secure",
			)
			const observed2 = yield* metadata.json
			assert.deepInclude(observed2, {
				resource,
				authorization_servers: [identity.issuer],
			})
			const message = {
				jsonrpc: "2.0" as const,
				id: 1,
				method: "server/discover",
				params: { _meta: Testing.metadata },
			}
			const forbidden = yield* rpc(
				resource,
				"server/discover",
				{},
				{ ...headers(message), authorization: "Bearer limited" },
			)
			assert.equal(forbidden.status, 403)
			assert.include(
				forbidden.headers["www-authenticate"],
				'error="insufficient_scope"',
			)
			assert.include(
				forbidden.headers["www-authenticate"],
				'scope="tools:read"',
			)
			assert.equal(
				(yield* rpc(
					resource,
					"server/discover",
					{},
					{ ...headers(message), authorization: "Bearer invalid" },
				)).status,
				401,
			)
			const kit = Toolkit.make(
				Tool.make("identity", {
					success: Schema.String,
					dependencies: [Principal],
				}),
			)
			yield* (yield* Graft.plugin(
				Tools.plugin({
					name: "test/identity",
					toolkit: kit,
					inject: [Principal],
					handlers: Effect.succeed(
						kit.of({
							identity: () =>
								Effect.map(Principal, (principal) => principal.subject),
						}),
					),
				}),
			)).await
			const client = yield* mcpClient(resource, McpProtocol.v2026_07_28, {
				authorization: "Bearer valid",
			})
			const tools = yield* client.listTools()
			const result = yield* client.callTool({ tool: tools[0]!, arguments: {} })
			assert.deepStrictEqual(result.content, [
				{ type: "text", text: '"Alice"' },
			])
			const visibility = yield* Graft.plugin(
				Plugin.make({
					name: "test/principal-visibility",
					apply: () =>
						Event.on(Middleware.Visible, (call) =>
							Effect.succeed(
								Context.getOrUndefined(call.services, Principal)?.subject ===
									"Alice",
							),
						),
				}),
			)
			yield* visibility.await
			const bob = yield* mcpClient(resource, McpProtocol.v2026_07_28, {
				authorization: "Bearer bob",
			})
			const observed3 = yield* bob.listTools()
			assert.deepStrictEqual(names(observed3), [])
			const observed4 = yield* client.listTools()
			assert.deepStrictEqual(names(observed4), ["identity"])
			yield* visibility.dispose
			const observed5 = yield* bob.listTools()
			assert.deepStrictEqual(names(observed5), ["identity"])
			assert.include((yield* SubscriptionRef.get(routes)).served, openMount)
			// Session termination is protected by the same scope guard as POST.
			const initialized = yield* post(
				resource,
				{
					jsonrpc: "2.0",
					id: 20,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "delete-test", version: "1" },
					},
				},
				{ authorization: "Bearer valid" },
			)
			assert.equal(initialized.status, 200)
			const sessionHeaders = {
				"mcp-session-id": initialized.headers["mcp-session-id"]!,
				"mcp-protocol-version": "2025-11-25",
			}
			const deniedDelete = yield* httpClient.del(resource, {
				headers: sessionHeaders,
			})
			assert.equal(deniedDelete.status, 401)
			const forbiddenDelete = yield* httpClient.del(resource, {
				headers: { ...sessionHeaders, authorization: "Bearer limited" },
			})
			assert.equal(forbiddenDelete.status, 403)
			const terminated = yield* httpClient.del(resource, {
				headers: { ...sessionHeaders, authorization: "Bearer valid" },
			})
			assert.equal(terminated.status, 204)
			const gone = yield* post(
				resource,
				{ jsonrpc: "2.0", id: 21, method: "tools/list", params: {} },
				{ ...sessionHeaders, authorization: "Bearer valid" },
			)
			assert.equal(gone.status, 404)
			yield* authorization.dispose
			yield* guarded.stable
			assert.equal((yield* rpc(resource, "server/discover")).status, 404)
			assert.include((yield* SubscriptionRef.get(routes)).served, openMount)
			assert.equal((yield* rpc(url + "/mcp", "server/discover")).status, 200)
		}).pipe(run),
)

it.live("HTTP config and listener changes preserve sibling activations", () =>
	Effect.gen(function* () {
		const { url, listening } = yield* start
		yield* (yield* Graft.plugin(core, {})).await
		const server = yield* capture(Server)
		const starts = yield* Ref.make(0)
		yield* (yield* Graft.plugin(
			Plugin.make({
				name: "test/contributor-starts",
				apply: () => Ref.update(starts, (n) => n + 1),
			}),
		)).await
		const stdio = yield* stdioTransport
		yield* (yield* Graft.plugin(stdio.plugin)).await
		const wire = yield* stdio.client
		const serving = yield* Graft.plugin(http, {})
		yield* serving.await
		const routes = yield* capture(Http.Routes)
		yield* serving.update({ path: "/renamed" })
		yield* serving.await
		assert.equal((yield* rpc(url + "/mcp", "server/discover")).status, 404)
		assert.equal((yield* rpc(url + "/renamed", "server/discover")).status, 200)
		const observed6 = yield* capture(Server)
		assert.strictEqual(observed6, server)
		const observed7 = yield* Ref.get(starts)
		assert.equal(observed7, 1)
		yield* wire.send({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: { _meta: Testing.metadata },
		})
		const observed8 = yield* Testing.response(wire, 1)
		assert.property(observed8, "result")
		const observed9 = yield* wire.closed.pipe(
			Effect.as(true),
			Effect.race(Effect.succeed(false)),
		)
		assert.isFalse(observed9)
		const mount = (yield* SubscriptionRef.get(routes)).served[0]
		yield* listening.update({ port: 0, host: "localhost" })
		yield* listening.await
		const next = yield* capture(Http.Server)
		assert.include((yield* SubscriptionRef.get(routes)).served, mount)
		assert.equal(
			(yield* rpc(next.url + "/renamed", "server/discover")).status,
			200,
		)
	}).pipe(run),
)

it.live(
	"stdio and HTTP share tools and observe contributor changes without reconnecting",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			yield* (yield* Graft.plugin(core, {})).await
			const stdio = yield* stdioTransport
			yield* (yield* Graft.plugin(stdio.plugin)).await
			const wire = yield* stdio.client
			yield* (yield* Graft.plugin(http, {})).await
			const client = yield* mcpClient(url + "/mcp", McpProtocol.v2026_07_28)
			yield* wire.send({
				jsonrpc: "2.0",
				id: 10,
				method: "subscriptions/listen",
				params: {
					_meta: Testing.metadata,
					notifications: { toolsListChanged: true },
				},
			})
			const observed10 = yield* wire.receive
			assert.propertyVal(
				observed10,
				"method",
				"notifications/subscriptions/acknowledged",
			)
			const observed11 = yield* client.listTools()
			assert.deepStrictEqual(names(observed11), [])
			const offered = yield* Graft.plugin(contributor("shared"))
			yield* offered.await
			const observed12 = yield* wire.receive
			assert.propertyVal(
				observed12,
				"method",
				"notifications/tools/list_changed",
			)
			const observed13 = yield* client.listTools()
			assert.deepStrictEqual(names(observed13), ["shared"])
			yield* wire.send({
				jsonrpc: "2.0",
				id: 11,
				method: "tools/call",
				params: { _meta: Testing.metadata, name: "shared", arguments: {} },
			})
			assert.propertyVal(
				(yield* Testing.response(wire, 11)).result,
				"structuredContent",
				"shared",
			)
			yield* offered.dispose
			const observed14 = yield* wire.receive
			assert.propertyVal(
				observed14,
				"method",
				"notifications/tools/list_changed",
			)
			const observed15 = yield* client.listTools()
			assert.deepStrictEqual(names(observed15), [])
		}).pipe(run),
)

it.live(
	"two isolated MCP groups share one HTTP listener without catalog or notification leaks",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const emitters = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([])
			for (const name of ["public", "admin"]) {
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "test/" + name,
						apply: () =>
							Effect.gen(function* () {
								yield* (yield* Graft.plugin(core, { name })).await
								yield* (yield* Graft.plugin(http, { path: `/${name}` })).await
								yield* (yield* Graft.plugin(contributor(name))).await
								const context = yield* Effect.context<Graft.Graft>()
								yield* Ref.update(emitters, (items) => [
									...items,
									Resources.updated("test://" + name).pipe(
										Effect.provide(context),
									),
								])
							}),
					}),
					undefined,
					{ isolate: Array.map(isolate, (key) => ({ key })) },
				)).await
			}
			const a = yield* connection(url + "/public")
			const b = yield* connection(url + "/admin")
			for (const [client, name] of [
				[a, "public"],
				[b, "admin"],
			] as const) {
				const typed = yield* mcpClient(
					url + "/" + name,
					McpProtocol.v2026_07_28,
				)
				const observed16 = yield* typed.listTools()
				assert.deepStrictEqual(names(observed16), [name])
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "subscriptions/listen",
					params: {
						_meta: Testing.metadata,
						notifications: {
							resourceSubscriptions: ["test://public", "test://admin"],
						},
					},
				})
				const observed17 = yield* client.receive
				assert.propertyVal(
					observed17,
					"method",
					"notifications/subscriptions/acknowledged",
				)
			}
			const updates = yield* Ref.get(emitters)
			// Each direction uses its own next update as a FIFO barrier while both listens stay open.
			for (const [source, target, ownUri] of [
				[0, 1, "test://admin"],
				[1, 0, "test://public"],
			] as const) {
				yield* updates[source]!
				const sourceUpdate = yield* [a, b][source]!.receive
				assert.propertyVal(
					sourceUpdate,
					"method",
					"notifications/resources/updated",
				)
				assert.propertyVal(
					"params" in sourceUpdate ? sourceUpdate.params : {},
					"uri",
					source === 0 ? "test://public" : "test://admin",
				)
				yield* updates[target]!
				const targetUpdate = yield* [a, b][target]!.receive
				assert.propertyVal(
					targetUpdate,
					"method",
					"notifications/resources/updated",
				)
				assert.propertyVal(
					"params" in targetUpdate ? targetUpdate.params : {},
					"uri",
					ownUri,
				)
			}
		}).pipe(run),
)

it.live(
	"HTTP preserves x-mcp-header annotations and validates mirrored parameters",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			yield* (yield* Graft.plugin(core, {})).await
			yield* (yield* Graft.plugin(http, {})).await
			const toolkit = Toolkit.make(
				Tool.make("annotated", {
					parameters: Schema.Struct({
						tenant: Schema.String.annotate({ "x-mcp-header": "Tenant" }),
					}),
					success: Schema.String,
				}),
			)
			yield* (yield* Graft.plugin(
				Tools.plugin({
					name: "test/annotated",
					toolkit,
					handlers: Effect.succeed(
						toolkit.of({ annotated: ({ tenant }) => Effect.succeed(tenant) }),
					),
				}),
			)).await
			const kind: Catalog.Kind<string> = {
				key: "test/header-tools",
				list: "tools",
				identities: (name) => [name],
				install: (name, annotations) =>
					McpServer.McpServer.use((server) =>
						server.addTool({
							tool: McpSchema.Tool.make({
								name,
								inputSchema: {
									type: "object",
									properties: {
										tenant: { type: "string", "x-mcp-header": "Tenant" },
									},
									required: ["tenant"],
								},
							}),
							annotations: Catalog.enabledWhen(annotations),
							handle: () =>
								Effect.succeed(McpSchema.CallToolResult.make({ content: [] })),
						}),
					),
			}
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/headers",
					apply: () => Catalog.offer(kind, "route"),
				}),
			)).await
			const client = yield* mcpClient(url + "/mcp", McpProtocol.v2026_07_28)
			const tools = yield* client.listTools()
			assert.notNestedProperty(
				tools[0],
				"inputSchema.properties.tenant.x-mcp-header",
			)
			const routed = tools[1]!
			assert.deepNestedPropertyVal(
				routed,
				"inputSchema.properties.tenant.x-mcp-header",
				"Tenant",
			)
			const result = yield* client.callTool({
				tool: routed,
				arguments: { tenant: "acme" },
			})
			assert.isFalse(result.isError ?? false)
			const message = {
				jsonrpc: "2.0" as const,
				id: 1,
				method: "tools/call",
				params: {
					_meta: Testing.metadata,
					name: "route",
					arguments: { tenant: "acme" },
				},
			}
			const mismatch = yield* rpc(url + "/mcp", "tools/call", message.params, {
				...headers(message),
				"mcp-param-tenant": "other",
			})
			assert.propertyVal(
				(mismatch.body as McpSchema.JsonRpcResponse).error,
				"code",
				McpSchema.HEADER_MISMATCH_ERROR_CODE,
			)
		}).pipe(run),
)

it.live(
	"HTTP template and prompt withdrawal enforce liveness including completions",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			yield* (yield* Graft.plugin(core, {})).await
			yield* (yield* Graft.plugin(http, {})).await
			const install = (name: string, answer: string) =>
				Plugin.make({
					name: "test/template/" + name,
					apply: () =>
						Effect.gen(function* () {
							const template =
								yield* Resources.template`note://${McpSchema.param(name, Schema.String)}`(
									{ name, content: () => Effect.succeed(answer) },
								)
							yield* Resources.offer(template)
						}),
				})
			const first = yield* Graft.plugin(install("first", "first"))
			yield* first.await
			yield* (yield* Graft.plugin(install("second", "second"))).await
			const before = yield* rpc(url + "/mcp", "resources/read", {
				uri: "note://entry",
			})
			assert.deepNestedPropertyVal(
				before.body,
				"result.contents[0].text",
				"first",
			)
			yield* first.dispose
			const after = yield* rpc(url + "/mcp", "resources/read", {
				uri: "note://entry",
			})
			assert.deepNestedPropertyVal(
				after.body,
				"result.contents[0].text",
				"second",
			)
			const prompt = yield* Graft.plugin(
				Plugin.make({
					name: "test/completed-prompt",
					apply: () =>
						Prompts.offer({
							name: "greet",
							parameters: { name: Schema.String },
							content: ({ name }) => Effect.succeed("Hello " + name),
							completion: { name: () => Effect.succeed(["Ada"]) },
						}),
				}),
			)
			yield* prompt.await
			const completion = {
				ref: { type: "ref/prompt", name: "greet" },
				argument: { name: "name", value: "A" },
			}
			const completed = yield* rpc(
				url + "/mcp",
				"completion/complete",
				completion,
			)
			assert.deepNestedPropertyVal(completed.body, "result.completion.values", [
				"Ada",
			])
			yield* prompt.dispose
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/replacement-prompt",
					apply: () =>
						Prompts.offer({
							name: "greet",
							content: () => Effect.succeed("Replacement"),
						}),
				}),
			)).await
			const withdrawn = yield* rpc(
				url + "/mcp",
				"completion/complete",
				completion,
			)
			assert.propertyVal(
				(withdrawn.body as McpSchema.JsonRpcResponse).error,
				"code",
				McpSchema.INVALID_PARAMS_ERROR_CODE,
			)
		}).pipe(run),
)

it.live("HTTP middleware skips lists and unload removes its policy", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		yield* (yield* Graft.plugin(core, {})).await
		yield* (yield* Graft.plugin(http, {})).await
		yield* (yield* Graft.plugin(contributor("visible"))).await
		const policy = yield* Graft.plugin(
			Plugin.make({
				name: "test/http-policy",
				apply: () =>
					Event.on(Middleware.Middleware, () =>
						Effect.fail(
							McpSchema.McpErrorBase.make({ code: -32000, message: "Denied" }),
						),
					),
			}),
		)
		yield* policy.await
		const listed = yield* rpc(url + "/mcp", "tools/list")
		assert.deepNestedPropertyVal(listed.body, "result.tools[0].name", "visible")
		const denied = yield* rpc(url + "/mcp", "tools/call", {
			name: "visible",
			arguments: {},
		})
		assert.propertyVal(
			(denied.body as McpSchema.JsonRpcResponse).error,
			"code",
			-32000,
		)
		yield* policy.dispose
		const allowed = yield* rpc(url + "/mcp", "tools/call", {
			name: "visible",
			arguments: {},
		})
		assert.deepNestedPropertyVal(
			allowed.body,
			"result.structuredContent",
			"visible",
		)
	}).pipe(run),
)
