import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import { Array, Effect, FileSystem, Layer, Option, Queue, Ref } from "effect"
import { ConfigDirectory, Include, ModuleResolver } from "../src/index"

it.live(
	"inherits the supplied configuration directory through nested includes",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const root = yield* fs.makeTempDirectoryScoped()
			yield* fs.makeDirectory(root + "/nested")
			yield* fs.writeFileString(
				root + "/graft.yml",
				"- id: child\n  name: include\n  isolate: { '@graftland/loader/Loader': true }\n  config: { path: ./nested/child.yml }\n",
			)
			yield* fs.writeFileString(
				root + "/nested/child.yml",
				"- id: leaf\n  name: ./reporter.js\n",
			)
			const observed = yield* Queue.unbounded<Option.Option<string>>()
			const reporter = Plugin.make({
				name: "reporter",
				apply: () =>
					ConfigDirectory.pipe(
						Effect.flatMap((directory) => Queue.offer(observed, directory)),
						Effect.asVoid,
					),
			})
			// Asserting inside the importer would only fail the nested entry, so record and check below.
			const specifiers = yield* Ref.make<ReadonlyArray<string>>([])
			const resolver = yield* ModuleResolver.make({
				base: "/unused",
				importer: (specifier) => {
					if (specifier === "include")
						return Effect.succeed({ default: Include.Include })
					return Ref.update(specifiers, Array.append(specifier)).pipe(
						Effect.as({ default: reporter }),
					)
				},
			})
			yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
			yield* Graft.plugin(Include.Include, { path: root + "/graft.yml" })
			const directory = yield* Queue.take(observed)
			assert.deepEqual(directory, Option.some(root + "/nested"))
			const imported = yield* Ref.get(specifiers)
			assert.deepEqual(imported, [
				new URL("file://" + root + "/nested/reporter.js").href,
			])
		}).pipe(
			Effect.scoped,
			Effect.provide(Graft.layer.pipe(Layer.provideMerge(NodeServices.layer))),
		),
)
