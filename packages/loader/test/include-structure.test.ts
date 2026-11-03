import { vi } from "vitest"
import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import { Array, Chunk, Effect, FileSystem, Path, String } from "effect"
import { parse } from "yaml"
import { Include } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

describe("aliased entry structure", () => {
	it.effect(
		"assigns distinct stable ids in aliased groups without changing ordinary config",
		() =>
			run((journal) => ({ echo: echo(journal) }))((journal) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = path.join(directory, "graft.yml")
					yield* fs.writeFileString(
						file,
						`- id: template
  name: unused
  disabled: true
  config: &children
    - name: echo
      config: &settings { text: hello }
- id: first
  name: group
  group: true
  config: *children
- id: second
  name: group
  group: true
  config: *children
- id: ordinary
  name: unused
  disabled: true
  config: *settings
`,
					)
					const fork = yield* Graft.plugin(Include.Include, { path: file })
					yield* fork.await
					const loader = yield* loaderService
					yield* loader.ready
					yield* journal.expect(["start hello", "start hello"])
					const entries = yield* loader.entries
					const text = yield* fs.readFileString(file)
					assert.include(text, "*settings")
					assert.deepStrictEqual(entries[0]?.config, [
						{ name: "echo", config: { text: "hello" } },
					])
					const first = entries[1]?.config
					const second = entries[2]?.config
					assert(Array.isArray(first) && Array.isArray(second))
					assert.notDeepEqual(first, second)
					assert.deepStrictEqual(parse(text), entries)
					yield* loader.update("ordinary", { disabled: true })
					const after = yield* loader.entries
					assert.deepStrictEqual(after, entries)
				}),
			),
	)

	for (const config of [
		"- id: source\n  name: unused\n  disabled: true\n  config: &children [{ id: child, name: unused, disabled: true }]\n- id: one\n  name: group\n  group: true\n  config: *children\n- id: two\n  name: group\n  group: true\n  config: *children\n",
		"- id: group\n  name: group\n  group: true\n  config: &children [{ name: group, group: true, config: *children }]\n",
	]) {
		it.effect(
			`rejects invalid aliased structure without rewriting it: ${String.includes("source")(config) ? "duplicate ids" : "cycle"}`,
			() =>
				run(() => ({}))(() =>
					Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem
						const path = yield* Path.Path
						const directory = yield* fs.makeTempDirectoryScoped()
						const file = path.join(directory, "graft.yml")
						yield* fs.writeFileString(file, config)
						const fork = yield* Graft.plugin(Include.Include, { path: file })
						const error = yield* Effect.flip(fork.await)
						assert.strictEqual(error._tag, "InvalidOperation")
						const after = yield* fs.readFileString(file)
						assert.strictEqual(after, config)
					}),
				),
		)
	}
})

it.effect.each(["null", "42", "invalid"])(
	"rejects an explicit non-array group config without rewriting it: %s",
	(config) =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				const text = `- name: group\n  group: true\n  config: ${config}\n`
				yield* fs.writeFileString(file, text)
				const included = yield* Graft.plugin(Include.Include, { path: file })
				const error = yield* Effect.flip(included.await)
				assert.strictEqual(error._tag, "InvalidOperation")
				const after = yield* fs.readFileString(file)
				assert.strictEqual(after, text)
			}),
		),
)

it.effect(
	"matches duplicate anonymous entries without quadratic bucket materialization",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				const count = 128
				const text = Array.join(
					Array.makeBy(
						count,
						() =>
							"- name: unused\n  disabled: true\n  config: { value: same }\n",
					),
					"",
				)
				yield* fs.writeFileString(file, text)
				const included = yield* Graft.plugin(Include.Include, { path: file })
				yield* included.await
				const loader = yield* loaderService
				yield* loader.ready
				const before = yield* loader.entries
				yield* fs.writeFileString(file, text)
				// Effect's Chunk iterator materializes every non-array backing. Count the
				// copied elements, not elapsed time, while Include restores anonymous IDs.
				const prototype = Object.getPrototypeOf(Chunk.empty()) as {
					[Symbol.iterator](this: Chunk.Chunk<unknown>): Iterator<unknown>
				}
				const iterate = prototype[Symbol.iterator]
				let copied = 0
				const spy = yield* Effect.acquireRelease(
					Effect.sync(() =>
						vi.spyOn(prototype, Symbol.iterator).mockImplementation(function (
							this: Chunk.Chunk<unknown>,
						) {
							const tag = Reflect.get(Reflect.get(this, "backing"), "_tag")
							if (tag !== "IArray" && tag !== "IEmpty") copied += this.length
							return iterate.call(this)
						}),
					),
					(spy) => Effect.sync(() => spy.mockRestore()),
				)
				yield* loader.update(before[0]!.id, { disabled: true })
				spy.mockRestore()
				const after = yield* loader.entries
				assert.deepStrictEqual(after, before)
				assert.isAtMost(
					copied,
					count * 4,
					"Matching must materialize only a linear number of bucket elements",
				)
			}),
		),
)
