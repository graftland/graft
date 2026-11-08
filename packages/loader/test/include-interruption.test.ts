import { Deferred, Effect, Fiber, FileSystem, Path, Stream } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { parse } from "yaml"

import { Include } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

describe("include edit lifetime", () => {
	it.effect(
		"keeps a committed file aligned with the runtime when the caller is interrupted",
		() =>
			run()(() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = path.join(directory, "graft.yml")
					const renamed = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					yield* fs.writeFileString(
						file,
						"- id: a\n  name: echo\n  config: { text: original }\n",
					)
					yield* Graft.provide(FileSystem.FileSystem, {
						...fs,
						rename: (from, to) =>
							fs
								.rename(from, to)
								.pipe(
									Effect.andThen(Deferred.succeed(renamed, undefined)),
									Effect.andThen(Deferred.await(release)),
								),
					})
					yield* Graft.plugin(Include.Include, { path: file })
					const loader = yield* loaderService
					yield* loader.ready
					const editing = yield* loader
						.update("a", { config: { text: "committed" } })
						.pipe(Effect.forkChild)
					yield* Deferred.await(renamed)
					yield* Fiber.interrupt(editing)
					const changed = yield* loader.changes.pipe(
						Stream.drop(1),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					)
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(changed)
					yield* loader.ready
					const persisted = yield* Effect.map(fs.readFileString(file), parse)
					const entries = yield* loader.entries
					assert.deepStrictEqual(entries, persisted)
				}),
			),
	)
})
