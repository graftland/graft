import { Array, Deferred, Effect, Layer } from "effect"
import { McpTest } from "effect/ai"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import core from "@graftland/plugin-mcp-server"
import { Server } from "@graftland/plugin-mcp-server/Server"

import clock from "../src/plugins/clock.ts"
import store from "../src/plugins/todo-store.ts"
import todo from "../src/plugins/todo.ts"

const names = (client: McpTest.Client) =>
	Effect.map(client.listTools(), (result) =>
		Array.sort(
			Array.map(result.tools, (tool) => tool.name),
			(left: string, right: string) =>
				left < right ? -1 : left > right ? 1 : 0,
		),
	)

it.effect(
	"serves the clock and todo tools, and drops todo with its store",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const ready = yield* Deferred.make<McpTest.Client>()
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/client",
					inject: [Server],
					apply: () =>
						Effect.gen(function* () {
							const options = yield* (yield* Server).options
							const client = yield* McpTest.makeClient(options.registrations, {
								...options,
								protocolVersion: "2025-11-25",
							})
							yield* Deferred.succeed(ready, client)
						}),
				}),
			)).await
			const client = yield* Deferred.await(ready)
			const storeFork = yield* Graft.plugin(store)
			for (const plugin of [clock, todo])
				yield* (yield* Graft.plugin(plugin)).await
			yield* storeFork.await
			const all = yield* names(client)
			assert.deepStrictEqual(all, ["add_todo", "current_time", "list_todos"])
			yield* client.callTool({ name: "add_todo", arguments: { title: "Ship" } })
			const listed = yield* client.callTool({
				name: "list_todos",
				arguments: {},
			})
			const text = Array.map(listed.content, (content) =>
				content.type === "text" ? content.text : "",
			)
			assert.deepStrictEqual(text, ['["Ship"]'])
			yield* storeFork.dispose
			const left = yield* names(client)
			assert.deepStrictEqual(left, ["current_time"])
		}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
)
