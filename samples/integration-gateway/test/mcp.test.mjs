import assert from "node:assert/strict"
import { test } from "node:test"

import {
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Ref,
	Result,
	Schedule,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import * as Projection from "@graftland/plugin-mcp-server/Projection"

import { Forecast, Get } from "@example/forecast-contract"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"

import { start } from "../host/dist/app.js"
import { expose } from "../host/dist/mcp.js"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const directory = new URL("../", import.meta.url).pathname
const promise = (run) =>
	Effect.tryPromise({ try: run, catch: (cause) => cause })

for (const target of [{ _tag: "Worker", execArgv: [] }, { _tag: "Local" }]) {
	test(
		`${target._tag}: an independent MCP client retains its session across a forecast transition`,
		{ timeout: 60_000 },
		() =>
			Effect.runPromise(
				Effect.gen(function* () {
					const app = yield* start(directory, target)
					const endpoint = yield* expose(app)
					const client = yield* Effect.acquireRelease(
						Effect.sync(
							() => new Client({ name: "forecast-proof", version: "1" }),
						),
						(client) => promise(() => client.close()).pipe(Effect.orDie),
					)
					const transport = new StreamableHTTPClientTransport(
						new URL(endpoint.url),
					)
					yield* promise(() => client.connect(transport))
					const session = transport.sessionId
					assert.ok(session)
					const listed = yield* promise(() => client.listTools())
					assert.equal(listed.tools.length, 1)
					assert.equal(listed.tools[0].name, "forecast")
					assert.equal(listed.tools[0].description, "Read the v1 city forecast")
					assert.deepEqual(listed.tools[0].annotations, {
						title: "City forecast",
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					})
					const call = (city) =>
						promise(() =>
							client.callTool({ name: "forecast", arguments: { city } }),
						)
					assert.deepEqual((yield* call("London")).structuredContent, {
						value: "v1 forecast for London",
					})
					const rejected = yield* Effect.result(endpoint.upgrade(""))
					assert.ok(Result.isFailure(rejected))
					assert.equal(rejected.failure._tag, "ProjectionError")
					assert.equal(rejected.failure.operation, "@example/forecast/Get@1")
					assert.deepEqual((yield* call("London")).structuredContent, {
						value: "v1 forecast for London",
					})
					const fs = yield* FileSystem.FileSystem
					const slow = yield* Effect.forkScoped(call("slow"))
					yield* fs.exists(app.input.started).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (exists) => exists,
						}),
					)
					const upgrade = yield* Effect.forkScoped(endpoint.upgrade())
					yield* call("London").pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (reply) =>
								reply.structuredContent?.value === "v2 forecast for London",
						}),
					)
					yield* fs.writeFileString(app.input.release, "release")
					assert.deepEqual((yield* Fiber.join(slow)).structuredContent, {
						value: "v1 forecast for slow",
					})
					const outcome = yield* Fiber.join(upgrade)
					assert.equal(outcome._tag, "Accepted")
					assert.ok(
						outcome.evidence.some(
							(item) => item.termination?.state === "Exited",
						),
					)
					assert.equal(
						(yield* promise(() => client.listTools())).tools[0].description,
						"Read the v2 city forecast",
					)
					assert.equal(transport.sessionId, session)
					const history = yield* endpoint.controller.history
					assert.equal(history.length, 2)
					assert.equal(
						history[1].before[0].metadata.description,
						"Read the v1 city forecast",
					)
					assert.equal(
						history[1].after[0].metadata.description,
						"Read the v2 city forecast",
					)
					assert.equal(yield* Ref.get(app.upstream.session), app.session)
					assert.equal(yield* Ref.get(app.upstream.logins), 1)
					assert.equal(yield* Ref.get(app.gatewayActivations), 1)
					assert.equal(yield* Ref.get(app.consumerActivations), 1)
					yield* endpoint.controller.update([
						Projection.operation(
							Forecast,
							Get.annotate(Projection.Annotation, {
								name: "forecast",
								title: "Discarded forecast",
								description: "Compute and discard the forecast",
								readOnlyHint: true,
								destructiveHint: false,
								idempotentHint: true,
								openWorldHint: false,
								output: "void",
							}),
							(forecast, { city }) => forecast.get(city),
						),
					])
					const discarded = yield* promise(() => client.listTools())
					assert.equal(discarded.tools[0].outputSchema, undefined)
					const discardedReply = yield* call("London")
					assert.equal(discardedReply.isError, false)
					assert.equal(discardedReply.structuredContent, undefined)
				}).pipe(Effect.scoped, Effect.provide(runtime)),
			),
	)
}

test(
	"stdio delivers the changed description to an independent client without reconnecting",
	{ timeout: 60_000 },
	() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const temporary = yield* fs.makeTempDirectoryScoped({
					prefix: "mcp-forecast-",
				})
				const file = temporary + "/status.json"
				const changed = yield* Deferred.make()
				const client = yield* Effect.acquireRelease(
					Effect.sync(
						() => new Client({ name: "stdio-forecast-proof", version: "1" }),
					),
					(client) => promise(() => client.close()).pipe(Effect.orDie),
				)
				const transport = new StdioClientTransport({
					command: process.execPath,
					args: [directory + "host/dist/mcp-stdio.js"],
					env: { GRAFT_GATEWAY_STATUS: file },
					stderr: "inherit",
				})
				yield* promise(() => client.connect(transport))
				const pid = transport.pid
				assert.ok(pid)
				yield* fs.exists(file).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (exists) => exists,
					}),
				)
				const status = JSON.parse(yield* fs.readFileString(file))
				assert.equal(status.session, "session-1")
				assert.equal(status.logins, 1)
				assert.equal(
					(yield* promise(() => client.listTools())).tools[0].description,
					"Read the v1 city forecast",
				)
				assert.deepEqual(
					(yield* promise(() =>
						client.callTool({
							name: "forecast",
							arguments: { city: "London" },
						}),
					)).structuredContent,
					{ value: "v1 forecast for London" },
				)
				client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
					Effect.runSync(Deferred.succeed(changed, undefined)),
				)
				const outcome = yield* promise(async () => {
					const reply = await fetch(status.operator + "/upgrade/v2", {
						method: "POST",
					})
					assert.equal(reply.status, 200)
					return reply.json()
				})
				assert.equal(outcome._tag, "Accepted")
				yield* Deferred.await(changed).pipe(Effect.timeout("5 seconds"))
				assert.equal(
					(yield* promise(() => client.listTools())).tools[0].description,
					"Read the v2 city forecast",
				)
				assert.deepEqual(
					(yield* promise(() =>
						client.callTool({
							name: "forecast",
							arguments: { city: "London" },
						}),
					)).structuredContent,
					{ value: "v2 forecast for London" },
				)
				assert.equal(transport.pid, pid)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		),
)
