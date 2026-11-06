import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Queue,
	Schema,
	Sink,
	Stdio,
	Stream,
} from "effect"
import { McpClient, McpProtocol } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Loader, ModuleResolver } from "@graftland/loader"
import listener from "@graftland/plugin-http"
import * as Http from "@graftland/plugin-http/Http"
import router from "@graftland/plugin-http/router"
import core from "@graftland/plugin-mcp-server"
import http from "@graftland/plugin-mcp-server/http"
import stdio from "@graftland/plugin-mcp-server/stdio"
import * as Testing from "@graftland/plugin-mcp-server/Testing"

import { parse } from "yaml"

import clock from "../src/plugins/clock.ts"
import content from "../src/plugins/content.ts"
import store from "../src/plugins/todo-store.ts"
import todo from "../src/plugins/todo.ts"

const capture = Effect.fnUntraced(function* <I, S>(key: Context.Key<I, S>) {
	const ready = yield* Deferred.make<S>()
	yield* (yield* Graft.plugin(
		Plugin.make({
			name: "test/sample/capture",
			inject: [key],
			apply: () =>
				Effect.flatMap(Effect.service(key), (value) =>
					Deferred.succeed(ready, value).pipe(Effect.asVoid),
				),
		}),
	)).await
	return yield* Deferred.await(ready)
})
const resolver = ModuleResolver.fromRecord({
	"@graftland/plugin-mcp-server": core,
	"@graftland/plugin-mcp-server/stdio": stdio,
	"@graftland/plugin-mcp-server/http": http,
	"@graftland/plugin-http": listener,
	"@graftland/plugin-http/router": router,
	"./src/plugins/clock.ts": clock,
	"./src/plugins/content.ts": content,
	"./src/plugins/todo-store.ts": store,
	"./src/plugins/todo.ts": todo,
})

for (const mode of ["stdio", "http"] as const) {
	it.live(
		mode + ": loads the sample configuration and serves its contributors",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const text = yield* fs.readFileString(
					new URL(
						mode === "stdio" ? "../graft.yml" : "../graft.http.yml",
						import.meta.url,
					).pathname,
				)
				const entries = yield* Schema.decodeUnknownEffect(Entry.Entries)(
					parse(text),
				)
				const names = Array.map(entries, (entry) => entry.name)
				if (mode === "stdio") {
					assert.include(names, "@graftland/plugin-mcp-server/stdio")
					assert.notInclude(names, "@graftland/plugin-http")
					assert.notInclude(names, "@graftland/plugin-mcp-server/http")
				} else {
					assert.include(names, "@graftland/plugin-http")
					assert.include(names, "@graftland/plugin-mcp-server/http")
					assert.notInclude(names, "@graftland/plugin-mcp-server/stdio")
				}
				const input = yield* Queue.unbounded<Uint8Array, Cause.Done>()
				const output = yield* Queue.unbounded<string | Uint8Array>()
				const messages = yield* Stream.fromQueue(output).pipe(
					Stream.map((chunk) =>
						typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
					),
					Stream.decodeText(),
					Stream.splitLines,
					Stream.mapEffect((line) => Testing.decode(line)),
					Stream.orDie,
					Stream.toQueue({ capacity: "unbounded" }),
				)
				const stdioContext = yield* Layer.build(
					Stdio.layerTest({
						stdin: Stream.fromQueue(input),
						stdout: () =>
							Sink.forEach((chunk: string | Uint8Array) =>
								Queue.offer(output, chunk),
							),
					}),
				)
				yield* Graft.provide(
					Stdio.Stdio,
					Context.get(stdioContext, Stdio.Stdio),
				)
				const configured = Array.map(entries, (entry) =>
					entry.name === "@graftland/plugin-http"
						? { ...entry, config: { port: 0 } }
						: entry,
				)
				yield* (yield* Graft.plugin(Loader.plugin, configured)).await
				yield* (yield* capture(Loader.Loader)).ready
				if (mode === "http") {
					const server = yield* capture(Http.Server)
					const context = yield* Layer.build(
						// @effect-diagnostics-next-line experimentalApiUsage:off -- the sample integration test uses the requested public HTTP client
						McpClient.layerHttp({
							name: "sample",
							version: "1",
							url: server.url + "/mcp",
							protocol: McpProtocol.v2026_07_28,
						}),
					)
					// @effect-diagnostics-next-line experimentalApiUsage:off -- the sample integration test uses the requested public HTTP client
					const client = Context.get(context, McpClient.McpClient)
					const tools = yield* client.listTools()
					assert.sameMembers(
						Array.map(tools, (tool) => tool.name),
						["current_time", "ask_name", "add_todo", "list_todos"],
					)
					const resource = yield* client.readResource({ uri: "greeting://Ada" })
					assert.deepInclude(resource, {
						contents: [{ uri: "greeting://Ada", text: "Hello Ada" }],
					})
				} else {
					const frame = yield* Testing.encode({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/list",
						params: { _meta: Testing.metadata },
					})
					yield* Queue.offer(input, new TextEncoder().encode(frame + "\n"))
					const response = yield* Queue.take(messages).pipe(
						Effect.orDie,
						Effect.repeat({
							until: (message) => "id" in message && message.id === 1,
						}),
					)
					const listed = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							result: Schema.Struct({
								tools: Schema.Array(Schema.Struct({ name: Schema.String })),
							}),
						}),
					)(response)
					assert.sameMembers(
						Array.map(listed.result.tools, (tool) => tool.name),
						["current_time", "ask_name", "add_todo", "list_todos"],
					)
					yield* Queue.end(input)
				}
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.provideMerge(
						Layer.fresh(Graft.layer),
						Layer.mergeAll(resolver, FetchHttpClient.layer, NodeServices.layer),
					),
				),
			),
	)
}
