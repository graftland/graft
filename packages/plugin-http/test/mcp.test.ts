import {
	Array,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Schema,
} from "effect"
import { McpClient, McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Http from "../src/Http.ts"
import { request, run, start } from "./utils.ts"

const toolkit = Toolkit.make(
	Tool.make("echo", {
		description: "Echo a message or wait",
		parameters: Schema.Struct({ wait: Schema.Boolean }),
		success: Schema.String,
	}),
)

it.live("hosts a streaming MCP app and cuts its in-flight RPC on unload", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const entered = yield* Deferred.make<void>(),
			stopped = yield* Deferred.make<void>()
		const handlers = toolkit.toLayer({
			echo: ({ wait }) =>
				wait
					? Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Deferred.succeed(stopped, undefined)),
						)
					: Effect.succeed("hello"),
		})
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "mcp-mount",
				apply: () =>
					Http.mount(
						McpServer.layerHttp({
							name: "test",
							version: "1",
							path: "/mcp",
							protocols: [McpProtocol.v2025_11_25],
							registrations: Layer.effectDiscard(
								McpServer.registerToolkit(toolkit),
							).pipe(Layer.provide(handlers)),
						}),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		const context = yield* Layer.build(
			// @effect-diagnostics-next-line experimentalApiUsage:off -- required interoperability test for Effect's MCP HTTP client
			McpClient.layerHttp({
				name: "test-client",
				version: "1",
				url: `${url}/mcp`,
				protocol: McpProtocol.v2025_11_25,
			}),
		)
		// @effect-diagnostics-next-line experimentalApiUsage:off -- required interoperability test for Effect's MCP HTTP client
		const client = Context.get(context, McpClient.McpClient)
		const tools = yield* client.listTools()
		assert.deepStrictEqual(
			Array.map(tools, (tool) => tool.name),
			["echo"],
		)
		const tool = tools[0]!
		const result = yield* client.callTool({ tool, arguments: { wait: false } })
		assert.deepStrictEqual(result.content, [{ type: "text", text: "hello" }])
		const call = yield* client
			.callTool({ tool, arguments: { wait: true } })
			.pipe(Effect.forkScoped)
		yield* Deferred.await(entered)
		yield* fork.dispose
		const exit = yield* Fiber.await(call).pipe(Effect.timeout("2 seconds"))
		assert.isTrue(Exit.isFailure(exit))
		const done = yield* Deferred.isDone(stopped)
		assert.isTrue(done)
		assert.strictEqual((yield* request(`${url}/mcp`, "POST")).status, 404)
	}).pipe(run),
)
