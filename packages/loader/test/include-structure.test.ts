import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import { Array, Effect, FileSystem, Path, String } from "effect"
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
