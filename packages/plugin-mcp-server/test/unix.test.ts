import { Array, Deferred, Effect, FileSystem, Layer, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, type Fork } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"

import core from "../src/index.ts"
import * as Testing from "../src/Testing.ts"
import unix from "./fixtures/unix.ts"
import { unixConnection } from "./wire.ts"

it.effect(
	"loads a third-party Unix transport by name using only public subpaths",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mcp-" })
			const path = directory + "/server.sock"
			const resolver = ModuleResolver.fromRecord({
				"@graftland/plugin-mcp-server": core,
				"mcp-server": core,
				"@acme/graft-plugin-mcp-unix": unix,
			})
			yield* Effect.gen(function* () {
				const loader = yield* Graft.plugin(Loader.plugin, [
					{
						id: "core",
						name: "mcp-server",
						config: { name: "unix", version: "1.2.3" },
					},
					{
						id: "transport",
						name: "@acme/graft-plugin-mcp-unix",
						config: { path },
					},
				])
				yield* loader.await
				const ready = yield* Deferred.make<Loader.Loader["Service"]>()
				yield* Graft.plugin(
					Plugin.make({
						name: "test/loader-probe",
						inject: [Loader.Loader],
						apply: () =>
							Loader.Loader.use((value) =>
								Deferred.succeed(ready, value).pipe(Effect.asVoid),
							),
					}),
				)
				yield* (yield* Deferred.await(ready)).ready
				const flatten = (
					nodes: ReadonlyArray<Fork.ForkTree>,
				): ReadonlyArray<Fork.ForkTree> =>
					Array.flatMap(nodes, (node) => [node, ...flatten(node.children)])
				yield* Graft.forks.pipe(
					Stream.map(flatten),
					Stream.filter((nodes) =>
						Array.some(
							nodes,
							(node) =>
								node.name === "@acme/graft-plugin-mcp-unix" &&
								node.state._tag === "Active" &&
								node.children.length === 0,
						),
					),
					Stream.runHead,
				)
				const client = yield* unixConnection(path)
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "server/discover",
					params: { _meta: Testing.metadata },
				})
				const result = yield* Testing.response(client, 1)
				assert.property(result, "result")
				yield* client.end
				yield* client.closed
			}).pipe(Effect.provide(Layer.provideMerge(Graft.layer, resolver)))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
