import {
	Array,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Record,
	Ref,
	Schema,
	Stdio,
	Stream,
	SubscriptionRef,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, type Fork } from "@graftland/graft"
import { Include, Loader } from "@graftland/loader"

import http from "../src/http.ts"
import core from "../src/index.ts"
import { isolate, Server } from "../src/Server.ts"
import stdio from "../src/stdio.ts"
import { fixture, moduleLayer } from "./module-fixtures"

it.effect(
	"transport configuration is local; core configuration restarts consumers but not contributors",
	() =>
		Effect.gen(function* () {
			const counts = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
			const contributorStarts = yield* Ref.make(0)
			const consumer = (name: string) =>
				Plugin.make({
					name,
					inject: [Server],
					config: Schema.Finite,
					apply: Effect.fnUntraced(function* (n) {
						const options = yield* (yield* Server).options
						yield* SubscriptionRef.update(
							counts,
							Array.append(name + ":" + n + ":" + options.version),
						)
					}),
				})
			const server = yield* Graft.plugin(core, {})
			yield* server.await
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/contributor",
					apply: () => Ref.update(contributorStarts, (n) => n + 1),
				}),
			)).await
			const a = yield* Graft.plugin(consumer("test/a"), 1)
			const b = yield* Graft.plugin(consumer("test/b"), 1)
			yield* a.await
			yield* b.await
			yield* a.update(2)
			yield* a.await
			const local = yield* SubscriptionRef.get(counts)
			assert.deepStrictEqual(local, [
				"test/a:1:0.0.0",
				"test/b:1:0.0.0",
				"test/a:2:0.0.0",
			])
			yield* server.update({ version: "2.0.0" })
			yield* server.await
			yield* SubscriptionRef.changes(counts).pipe(
				Stream.filter((items) => items.length === 5),
				Stream.runHead,
			)
			const restarted = yield* SubscriptionRef.get(counts)
			assert.sameMembers(Array.takeRight(restarted, 2), [
				"test/a:2:2.0.0",
				"test/b:1:2.0.0",
			])
			const starts = yield* Ref.get(contributorStarts)
			assert.equal(starts, 1)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

for (const full of [false, true]) {
	it.effect(
		"Loader resolves core, stdio and HTTP entries: " +
			(full ? "full names" : "short names"),
		() =>
			Effect.gen(function* () {
				const ready = yield* Deferred.make<Loader.Loader["Service"]>()
				yield* (yield* Graft.plugin(Loader.plugin, [
					{ id: "core", name: full ? core.name : "mcp-server" },
					{ id: "stdio", name: full ? stdio.name : "mcp-server/stdio" },
					{ id: "http", name: full ? http.name : "mcp-server/http" },
				])).await
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "test/loader",
						inject: [Loader.Loader],
						apply: () =>
							Loader.Loader.use((loader) =>
								Deferred.succeed(ready, loader).pipe(Effect.asVoid),
							),
					}),
				)).await
				const loader = yield* Deferred.await(ready)
				yield* loader.ready
				const flatten = (
					nodes: ReadonlyArray<Fork.ForkTree>,
				): ReadonlyArray<Fork.ForkTree> =>
					Array.flatMap(nodes, (node) => [node, ...flatten(node.children)])
				yield* Graft.forks.pipe(
					Stream.map(flatten),
					Stream.filter((nodes) =>
						Array.every([stdio.name, http.name], (name) =>
							Array.some(
								nodes,
								(node) =>
									node.name === name &&
									node.children.length === 0 &&
									node.state._tag === "Active",
							),
						),
					),
					Stream.runHead,
				)
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Graft.layer.pipe(
						Layer.provideMerge([
							moduleLayer({
								[core.name]: fixture(
									"plugin-mcp-server-lifecycle-[core.name]-0",
								),
								"mcp-server": fixture(
									"plugin-mcp-server-lifecycle-mcp-server-1",
								),
								[stdio.name]: fixture(
									"plugin-mcp-server-lifecycle-[stdio.name]-2",
								),
								"mcp-server/stdio": fixture(
									"plugin-mcp-server-lifecycle-mcp-server-stdio-3",
								),
								[http.name]: fixture(
									"plugin-mcp-server-lifecycle-[http.name]-4",
								),
								"mcp-server/http": fixture(
									"plugin-mcp-server-lifecycle-mcp-server-http-5",
								),
							}),
							Stdio.layerTest({ stdin: Stream.never }),
						]),
					),
				),
			),
	)
}

it.effect("MCP group isolation anchors survive Loader id write-back", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped({
			prefix: "mcp-config-",
		})
		const path = directory + "/graft.yml"
		const keys = Array.join(
			Array.map(isolate, (key) => '    "' + key + '": true'),
			"\n",
		)
		yield* fs.writeFileString(
			path,
			"- name: public\n  group: true\n  isolate: &mcp\n" +
				keys +
				"\n  config:\n    - name: mcp-server\n- name: admin\n  group: true\n  isolate: *mcp\n  config:\n    - name: mcp-server\n",
		)
		yield* (yield* Graft.plugin(Include.Include, { path })).await
		const ready = yield* Deferred.make<Loader.Loader["Service"]>()
		yield* (yield* Graft.plugin(
			Plugin.make({
				name: "test/anchor-probe",
				inject: [Loader.Loader],
				apply: () =>
					Loader.Loader.use((loader) =>
						Deferred.succeed(ready, loader).pipe(Effect.asVoid),
					),
			}),
		)).await
		const loader = yield* Deferred.await(ready)
		yield* loader.ready
		const entries = yield* loader.entries
		assert.deepStrictEqual(entries[0]?.isolate, entries[1]?.isolate)
		assert.equal(Record.keys(entries[0]?.isolate ?? {}).length, 7)
		assert.isString(entries[0]?.id)
		const written = yield* fs.readFileString(path)
		assert.include(written, "&mcp")
		assert.include(written, "*mcp")
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Graft.layer.pipe(
				Layer.provideMerge([
					NodeServices.layer,
					moduleLayer({
						"mcp-server": fixture("plugin-mcp-server-lifecycle-mcp-server-0"),
					}),
				]),
			),
		),
	),
)
