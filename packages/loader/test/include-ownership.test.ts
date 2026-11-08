import { Effect, FileSystem, Path } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Include } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = path.join(directory, "graft.yml")
	yield* Graft.plugin(Include.Include, { path: file })
	const loader = yield* loaderService
	const config = { text: "before" }
	yield* loader.create({ id: "entry", name: "echo", config })
	yield* loader.ready
	return { fs, file, loader, config }
})
it.effect(
	"keeps the persisted target consistent with the file after caller mutation",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const { fs, file, loader, config } = yield* setup
				config.text = "after"
				const disk = yield* fs.readFileString(file)
				assert.include(disk, "before")
				const entries = yield* loader.entries
				assert.deepStrictEqual(entries[0]?.config, { text: "before" })
			}),
		),
)
it.effect("applies an explicitly submitted update after caller mutation", () =>
	run()((journal) =>
		Effect.gen(function* () {
			const { fs, file, loader, config } = yield* setup
			config.text = "after"
			yield* loader.update("entry", { config })
			yield* loader.ready
			const disk = yield* fs.readFileString(file)
			assert.include(disk, "after")
			const entries = yield* loader.entries
			assert.deepStrictEqual(entries[0]?.config, { text: "after" })
			yield* journal.expect(["start before", "stop before", "start after"])
		}),
	),
)
