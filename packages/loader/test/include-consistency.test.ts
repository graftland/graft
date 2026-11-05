import {
	Cause,
	Effect,
	Exit,
	FileSystem,
	Option,
	Path,
	Ref,
	Schema,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { parse } from "yaml"

import { Include } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = path.join(directory, "graft.yml")
	yield* fs.writeFileString(
		file,
		"- id: a\n  name: echo\n  config: { text: original }\n",
	)
	yield* Graft.plugin(Include.Include, { path: file })
	const loader = yield* loaderService
	yield* loader.ready
	return { fs, file, loader }
})

describe("include consistency", () => {
	it.effect("rejects deleting a required field before writing the file", () =>
		run((journal) => ({ echo: echo(journal) }))(() =>
			Effect.gen(function* () {
				const { fs, file, loader } = yield* setup
				const before = yield* fs.readFileString(file)
				const entries = yield* loader.entries
				const result = yield* Effect.exit(
					loader.update("a", { name: undefined }),
				)
				assert(Exit.isFailure(result))
				const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
				assert(error._tag === "InvalidOperation")
				assert(Schema.isSchemaError(error.cause))
				const after = yield* fs.readFileString(file)
				const current = yield* loader.entries
				assert.strictEqual(after, before)
				assert.deepStrictEqual(current, entries)
				yield* loader.update("a", { config: undefined })
				const updated = yield* loader.entries
				assert.deepStrictEqual(updated, [{ id: "a", name: "echo" }])
			}),
		),
	)
	it.effect(
		"rejects negative positions before changing either the file or the tree",
		() =>
			run((journal) => ({ echo: echo(journal) }))(() =>
				Effect.gen(function* () {
					const { fs, file, loader } = yield* setup
					const before = yield* fs.readFileString(file)
					const entries = yield* loader.entries
					const result = yield* Effect.exit(
						loader.create(
							{ id: "b", name: "echo", disabled: true },
							{ position: -1 },
						),
					)
					assert(Exit.isFailure(result))
					const after = yield* fs.readFileString(file)
					const current = yield* loader.entries
					assert.strictEqual(after, before)
					assert.deepStrictEqual(current, entries)
				}),
			),
	)

	it.effect("preserves distinct ids for two identical anonymous entries", () =>
		run((journal) => ({ echo: echo(journal) }))(() =>
			Effect.gen(function* () {
				const { fs, file, loader } = yield* setup
				const anonymous =
					"- name: echo\n  config: { text: original }\n- name: echo\n  config: { text: original }\n"
				yield* fs.writeFileString(file, anonymous)
				yield* loader.create({ id: "marker", name: "echo", disabled: true })
				const first = yield* loader.entries
				assert.notStrictEqual(first[0]?.id, first[1]?.id)
				yield* fs.writeFileString(file, anonymous)
				yield* loader.create({ id: "marker", name: "echo", disabled: true })
				const second = yield* loader.entries
				assert.deepStrictEqual(second, first)
			}),
		),
	)

	it.effect(
		"preserves an anonymous entry's id when moving into and out of a group",
		() =>
			run((journal) => ({ echo: echo(journal) }))(() =>
				Effect.gen(function* () {
					const { fs, file, loader } = yield* setup
					yield* fs.writeFileString(
						file,
						"- id: group\n  name: group\n  group: true\n  config:\n    - name: echo\n      config: { text: original }\n",
					)
					yield* loader.create({ id: "marker", name: "echo", disabled: true })
					const nested = yield* loader.entries
					assert.deepStrictEqual(nested[0]?.config, [
						{ id: "a", name: "echo", config: { text: "original" } },
					])
					yield* fs.writeFileString(
						file,
						"- name: echo\n  config: { text: original }\n",
					)
					yield* loader.create({ id: "marker", name: "echo", disabled: true })
					const moved = yield* loader.entries
					assert.strictEqual(moved[0]?.id, "a")
				}),
			),
	)
	it.effect(
		"does not persist a failed edit during the next successful edit",
		() =>
			run((journal) => ({ echo: echo(journal) }))(() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const fail = yield* Ref.make(false)
					yield* Graft.provide(FileSystem.FileSystem, {
						...fs,
						rename: (source, target) =>
							Effect.flatMap(Ref.get(fail), (failed) =>
								fs.rename(failed ? `${source}.missing` : source, target),
							),
					})
					const { file, loader } = yield* setup
					yield* Ref.set(fail, true)
					const failed = yield* Effect.exit(
						loader.update("a", { config: { text: "failed" } }),
					)
					assert(Exit.isFailure(failed))
					yield* Ref.set(fail, false)
					yield* loader.update("a", { disabled: true })
					const persisted = yield* Effect.map(fs.readFileString(file), parse)
					const entries = yield* loader.entries
					assert.deepStrictEqual(persisted, entries)
				}),
			),
	)
	it.effect(
		"returns a typed error for malformed edits on disk and recovers",
		() =>
			run((journal) => ({ echo: echo(journal) }))(() =>
				Effect.gen(function* () {
					const { fs, file, loader } = yield* setup
					const original = yield* fs.readFileString(file)
					yield* fs.writeFileString(file, "- [broken\n")
					const exit = yield* Effect.exit(
						loader.update("a", { disabled: true }),
					)
					assert(Exit.isFailure(exit))
					assert.isTrue(Option.isSome(Cause.findErrorOption(exit.cause)))
					const broken = yield* fs.readFileString(file)
					assert.strictEqual(broken, "- [broken\n")
					yield* fs.writeFileString(file, original)
					yield* loader.update("a", { config: { text: "recovered" } })
					const persisted = yield* Effect.map(fs.readFileString(file), parse)
					const entries = yield* loader.entries
					assert.deepStrictEqual(persisted, entries)
				}),
			),
	)

	it.effect("does not reuse an id that is still explicitly present", () =>
		run((journal) => ({ echo: echo(journal) }))(() =>
			Effect.gen(function* () {
				const { fs, file, loader } = yield* setup
				yield* fs.writeFileString(
					file,
					"- name: echo\n  config: { text: original }\n- id: a\n  name: echo\n  config: { text: original }\n",
				)
				yield* loader.update("a", { disabled: true })
				const entries = yield* loader.entries
				assert.strictEqual(entries.length, 2)
				assert.notStrictEqual(entries[0]?.id, entries[1]?.id)
				const persisted = yield* Effect.map(fs.readFileString(file), parse)
				assert.deepStrictEqual(persisted, entries)
			}),
		),
	)

	it.effect("does not rewrite invalid entries just to assign ids", () =>
		run((journal) => ({ echo: echo(journal) }))(() =>
			Effect.gen(function* () {
				const { fs, file, loader } = yield* setup
				const invalid = "- name: 42\n"
				yield* fs.writeFileString(file, invalid)
				yield* Effect.exit(loader.update("a", { disabled: true }))
				const persisted = yield* fs.readFileString(file)
				assert.strictEqual(persisted, invalid)
			}),
		),
	)
})
