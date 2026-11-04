import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import {
	Array,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Option,
	Path,
	Schema,
} from "effect"
import { parse } from "yaml"
import { Include, Loader } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

const isStoreError = Schema.is(Loader.StoreError)

const original = `- id: a
  name: echo
  config: &shared { text: original }
- id: b
  name: echo
  config: *shared # Keep this comment
- id: c
  name: unused
  disabled: true
  config: &other { text: untouched }
- id: d
  name: unused
  disabled: true
  config: *other
`

const setup = Effect.fn("setup")(function* (text: string = original) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = path.join(directory, "graft.yml")
	yield* fs.writeFileString(file, text)
	yield* Graft.plugin(Include.Include, { path: file })
	const loader = yield* loaderService
	yield* loader.ready
	return { fs, file, loader }
})

describe("YAML alias edits", () => {
	for (const operation of ["update", "create", "remove"] as const) {
		it.effect(
			`can ${operation} a child inside an aliased group without changing the source`,
			() =>
				run((journal) => ({ echo: echo(journal) }))(() =>
					Effect.gen(function* () {
						const { fs, file, loader } = yield* setup(`- id: source
  name: unused
  disabled: true
  config: &children
    - id: child
      name: echo
      config: { text: original }
- id: group
  name: group
  group: true
  config: *children
`)
						const before = yield* loader.entries
						if (operation === "update")
							yield* loader.update("child", { config: { text: "changed" } })
						else if (operation === "create")
							yield* loader.create(
								{ id: "new", name: "unused", disabled: true },
								{ parent: "group" },
							)
						else yield* loader.remove("child")
						yield* loader.ready
						const entries = yield* loader.entries
						const text = yield* fs.readFileString(file)
						assert.deepStrictEqual(entries[0], before[0])
						assert.deepStrictEqual(parse(text), entries)
					}),
				),
		)
	}
	it.effect("reuses an anonymous entry's id when its config is an alias", () =>
		run((journal) => ({ echo: echo(journal) }))(() =>
			Effect.gen(function* () {
				const anonymous =
					"- id: a\n  name: echo\n  config: &shared { text: original }\n- name: echo\n  config: *shared\n"
				const { fs, file, loader } = yield* setup(anonymous)
				const before = yield* loader.entries
				yield* fs.writeFileString(file, anonymous)
				yield* loader.create({ id: "marker", name: "unused", disabled: true })
				const after = yield* loader.entries
				assert.strictEqual(after[1]?.id, before[1]?.id)
			}),
		),
	)
	for (const operation of [
		"replace",
		"delete field",
		"remove entry",
	] as const) {
		it.effect(
			`preserves alias values when an anchor is changed by ${operation}`,
			() =>
				run((journal) => ({ echo: echo(journal) }))(() =>
					Effect.gen(function* () {
						const { fs, file, loader } = yield* setup()
						if (operation === "remove entry") yield* loader.remove("a")
						else
							yield* loader.update("a", {
								config:
									operation === "replace" ? { text: "changed" } : undefined,
							})
						yield* loader.ready
						const text = yield* fs.readFileString(file)
						const entries = yield* loader.entries
						assert.deepStrictEqual(parse(text), entries)
						assert.deepStrictEqual(
							Option.getOrThrow(
								Array.findFirst(entries, (entry) => entry.id === "b"),
							).config,
							{ text: "original" },
						)
						assert.include(text, "# Keep this comment")
						assert.include(text, "&other")
						assert.include(text, "*other")
						// A later edit must read the materialized value without reintroducing the anchor.
						yield* loader.update("b", { disabled: true })
						const after = yield* fs.readFileString(file)
						const current = yield* loader.entries
						assert.deepStrictEqual(parse(after), current)
					}),
				),
		)
	}

	it.effect("materializes nested aliases and preserves environment tags", () =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				const { fs, file, loader } = yield* setup(`- id: a
  name: echo
  config: &shared { text: &greeting !env GREETING }
- id: b
  name: echo
  config: *shared
- id: c
  name: echo
  config: { text: *greeting }
`)
				yield* loader.remove("a")
				yield* loader.ready
				const text = yield* fs.readFileString(file)
				assert.include(text, "!env GREETING")
				assert.notInclude(text, "*shared")
				assert.notInclude(text, "*greeting")
				yield* journal.expect(["start hi", "start hi", "start hi", "stop hi"])
			}),
		),
	)

	it.effect(
		"returns serialization failures through StoreError without changing the file",
		() =>
			run((journal) => ({ echo: echo(journal) }))(() =>
				Effect.gen(function* () {
					const { fs, file, loader } = yield* setup()
					const before = yield* loader.entries
					const result = yield* Effect.exit(
						loader.update("c", { config: Symbol("unsupported") }),
					)
					assert(Exit.isFailure(result))
					const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
					if (!isStoreError(error)) assert.fail("Expected StoreError")
					assert.instanceOf(error.cause, Error)
					const text = yield* fs.readFileString(file)
					const entries = yield* loader.entries
					assert.strictEqual(text, original)
					assert.deepStrictEqual(entries, before)
					yield* loader.update("c", { config: { text: "recovered" } })
				}),
			),
	)

	it.effect(
		"returns unresolved aliases as typed failures and recovers after repair",
		() =>
			run((journal) => ({ echo: echo(journal) }))(() =>
				Effect.gen(function* () {
					const { fs, file, loader } = yield* setup()
					yield* fs.writeFileString(
						file,
						"- id: a\n  name: echo\n  config: *missing\n",
					)
					const result = yield* Effect.exit(
						loader.update("a", { disabled: true }),
					)
					assert(Exit.isFailure(result))
					const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
					if (!isStoreError(error)) assert.fail("Expected StoreError")
					assert.instanceOf(error.cause, ReferenceError)
					yield* fs.writeFileString(file, original)
					yield* loader.update("a", { config: { text: "recovered" } })
				}),
			),
	)
})
