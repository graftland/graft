import { Effect, FileSystem, Path } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Entry, Include, Loader } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

describe("recovery", () => {
	it.effect("loads an entry again once its environment variable is fixed", () =>
		run()((journal) =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{
						id: "e",
						name: "echo",
						config: { text: new Entry.Env({ name: "MISSING" }) },
					},
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.update("e", { config: { text: "fixed" } })
				yield* loader.ready
				yield* journal.expect(["start fixed"])
			}),
		),
	)
})

describe("empty config files", () => {
	it.effect("creates the first entry in a file with only comments", () =>
		run()((journal) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = path.join(directory, "graft.yml")
				yield* fs.writeFileString(file, "# Nothing yet\n")
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.create({ name: "echo", config: { text: "first" } })
				yield* loader.ready
				yield* journal.expect(["start first"])
				const text = yield* fs.readFileString(file)
				assert.include(text, "# Nothing yet")
				assert.include(text, "text: first")
			}),
		),
	)
})
