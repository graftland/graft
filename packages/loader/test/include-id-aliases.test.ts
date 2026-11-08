import { Array, Effect, FileSystem } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { parse } from "yaml"

import { Include } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

const source =
	"- &template\n  name: unused\n  disabled: true\n- name: observer\n  config: *template # Keep the observer comment\n"

it.effect(
	"keeps an anonymous alias consumer's input and identity across rereads",
	() =>
		run({ observer: fixture("observer") })((journal) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				yield* fs.writeFileString(file, source)
				const fork = yield* Graft.plugin(Include.Include, { path: file })
				yield* fork.await
				const loader = yield* loaderService
				yield* loader.ready
				const before = yield* loader.entries
				assert.deepStrictEqual(before[1]?.config, {
					name: "unused",
					disabled: true,
				})
				yield* fs.writeFileString(file, source)
				yield* loader.create({ id: "marker", name: "unused", disabled: true })
				yield* loader.ready
				const after = yield* loader.entries
				assert.deepStrictEqual(
					Array.map(Array.take(after, 2), (entry) => entry.id),
					Array.map(before, (entry) => entry.id),
				)
				yield* journal.expect(["start observer"])
				const written = yield* fs.readFileString(file)
				assert.include(written, "Keep the observer comment")
				assert.deepStrictEqual(parse(written), after)
			}),
		),
)

it.effect(
	"protects aliases to ancestors of anonymous entries without materializing unrelated aliases",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				yield* fs.writeFileString(
					file,
					`- id: group
  name: group
  group: true
  config: &children
    - name: unused
      disabled: true
      config: &settings { text: unchanged }
- id: observer
  name: unused
  disabled: true
  config: *children
- id: unrelated
  name: unused
  disabled: true
  config: *settings
`,
				)
				const fork = yield* Graft.plugin(Include.Include, { path: file })
				yield* fork.await
				const loader = yield* loaderService
				const entries = yield* loader.entries
				assert.deepStrictEqual(entries[1]?.config, [
					{ name: "unused", disabled: true, config: { text: "unchanged" } },
				])
				const written = yield* fs.readFileString(file)
				assert.include(written, "*settings")
				assert.deepStrictEqual(parse(written), entries)
			}),
		),
)

it.effect(
	"keeps distinct alias occurrences when an anchor name is reused",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				yield* fs.writeFileString(
					file,
					`- &template
  name: unused
  disabled: true
  note: first
- id: first
  name: unused
  disabled: true
  config: *template
- &template
  name: unused
  disabled: true
  note: second
- id: second
  name: unused
  disabled: true
  config: *template
`,
				)
				const fork = yield* Graft.plugin(Include.Include, { path: file })
				yield* fork.await
				const loader = yield* loaderService
				const entries = yield* loader.entries
				assert.deepStrictEqual(entries[1]?.config, {
					name: "unused",
					disabled: true,
					note: "first",
				})
				assert.deepStrictEqual(entries[3]?.config, {
					name: "unused",
					disabled: true,
					note: "second",
				})
				const written = yield* fs.readFileString(file)
				assert.deepStrictEqual(parse(written), entries)
			}),
		),
)
