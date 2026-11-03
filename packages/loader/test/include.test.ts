import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import { Effect, FileSystem, Path, String as Str } from "effect"
import { Include } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

const original = `# Plugins for the test
- name: echo # greets
  config:
    text: !env GREETING
`

const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = path.join(directory, "graft.yml")
	yield* fs.writeFileString(file, original)
	return { fs, file }
})

describe("include", () => {
	it.effect(
		"persists ids for anonymous entries and keeps the file's formatting",
		() =>
			run((journal) => ({ echo: echo(journal) }))((journal) =>
				Effect.gen(function* () {
					const { fs, file } = yield* setup
					yield* Graft.plugin(Include.Include, { path: file })
					const loader = yield* loaderService
					yield* loader.ready
					yield* journal.expect(["start hi"])
					const text = yield* fs.readFileString(file)
					assert.include(text, "# Plugins for the test")
					assert.include(text, "!env GREETING")
					const [entry] = yield* loader.entries
					assert.isDefined(entry)
					assert.match(text, new RegExp(`id: "?${entry?.id}"?`))

					yield* loader.update(entry?.id ?? "", { config: { text: "bye" } })
					yield* loader.ready
					const updated = yield* fs.readFileString(file)
					assert.include(updated, "# greets")
					assert.include(updated, "text: bye")
					yield* journal.expect(["start hi", "stop hi", "start bye"])
				}),
			),
	)

	it.effect("lets the file win when it changed the same field first", () =>
		run((journal) => ({ echo: echo(journal) }))(() =>
			Effect.gen(function* () {
				const { fs, file } = yield* setup
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				yield* loader.ready
				const [entry] = yield* loader.entries
				const id = entry?.id ?? ""
				const onDisk = yield* fs.readFileString(file)
				yield* fs.writeFileString(
					file,
					Str.replace("text: !env GREETING", "text: from disk")(onDisk),
				)
				yield* loader.update(id, { config: { text: "from memory" } })
				const text = yield* fs.readFileString(file)
				assert.include(text, "text: from disk")
				assert.notInclude(text, "from memory")
			}),
		),
	)

	it.live("picks up edits made to the file while running", () =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				const { fs, file } = yield* setup
				yield* Graft.plugin(Include.Include, { path: file, watch: true })
				const loader = yield* loaderService
				yield* loader.ready
				const onDisk = yield* fs.readFileString(file)
				yield* fs.writeFileString(
					file,
					Str.replace("text: !env GREETING", "text: edited")(onDisk),
				)
				yield* journal.eventually(["start hi", "stop hi", "start edited"])
			}),
		),
	)
})
