import {
	Array,
	Effect,
	FileSystem,
	Option,
	Result,
	Stream,
	String,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { expectTypeOf } from "vitest"
import { parse } from "yaml"

import { Include, Loader, Tree, type Entry } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

const setup = Effect.fn("setup")(function* (text: string) {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = `${directory}/graft.yml`
	yield* fs.writeFileString(file, text)
	const included = yield* Graft.plugin(Include.Include, { path: file })
	yield* included.await
	const loader = yield* loaderService
	yield* loader.ready
	return { fs, file, loader }
})

it.effect("preserves anonymous group identity and running children", () =>
	run((journal) => ({ echo: echo(journal) }))((journal) =>
		Effect.gen(function* () {
			const text =
				"- name: group\n  group: true\n  config:\n    - name: echo\n      config: { text: unchanged }\n"
			const { fs, file, loader } = yield* setup(text)
			const before = yield* loader.entries
			yield* fs.writeFileString(file, text)
			yield* loader.create({ id: "marker", name: "unused", disabled: true })
			yield* loader.ready
			yield* journal.expect(["start unchanged"])
			const after = yield* loader.entries
			assert.strictEqual(after[0]?.id, before[0]?.id)
		}),
	),
)

it.effect("updates an accepted nested entry with an unknown field", () =>
	run(() => ({}))(() =>
		Effect.gen(function* () {
			const { loader } = yield* setup(
				"- id: group\n  name: group\n  group: true\n  config:\n    - id: child\n      name: unused\n      disabled: true\n      note: keep\n",
			)
			yield* loader.update("child", { disabled: true })
		}),
	),
)

it.effect("loads a group with omitted config as an empty group", () =>
	run(() => ({}))(() =>
		Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [
				{ id: "empty", name: "group", group: true },
			])
			const loader = yield* loaderService
			yield* loader.ready
			const snapshot = yield* Stream.runHead(Graft.forks)
			const root = Option.getOrThrow(
				Array.findFirst(
					Array.flatMap(Option.getOrThrow(snapshot), (node) => node.children),
					(node) => node.id === loader.root.id,
				),
			)
			assert.strictEqual(root.children[0]?.state._tag, "Active")
			const entries = yield* loader.entries
			assert.deepStrictEqual(entries[0]?.config, [])
		}),
	),
)

it.effect(
	"restores nested anonymous identities without collapsing identical groups",
	() =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				const branch =
					"    - name: group\n      group: true\n      config:\n        - name: echo\n          config: { text: unchanged }\n"
				const text = `- name: group\n  group: true\n  config:\n${branch}${branch}    - name: group\n      group: true\n`
				const { fs, file, loader } = yield* setup(text)
				const initial = yield* loader.entries
				assert.strictEqual(Tree.ids(initial).length, 6)
				assert.strictEqual(Array.dedupe(Tree.ids(initial)).length, 6)
				for (const id of ["first-marker", "second-marker"]) {
					yield* fs.writeFileString(file, text)
					yield* loader.create({ id, name: "unused", disabled: true })
					yield* loader.ready
					const current = yield* loader.entries
					assert.deepStrictEqual(Array.dropRight(current, 1), initial)
					yield* journal.expect(["start unchanged", "start unchanged"])
				}
			}),
		),
)

for (const nested of [false, true]) {
	it.effect(
		`preserves metadata through edits and rereads at ${nested ? "nested" : "root"} depth`,
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const child =
						"- id: child\n  name: unused\n  disabled: true\n  note: { text: keep } # handwritten metadata\n"
					const text = nested
						? `- id: group\n  name: group\n  group: true\n  note: parent\n  config:\n${Array.join(
								Array.map(
									String.split(String.trimEnd(child), "\n"),
									(line) => `    ${line}`,
								),
								"\n",
							)}\n`
						: child
					const { fs, file, loader } = yield* setup(text)
					const childOf = (entries: ReadonlyArray<Entry.Entry>) =>
						nested
							? Option.getOrThrow(
									Tree.childrenOf(Option.getOrThrow(Array.head(entries))),
								)[0]
							: entries[0]
					const initial = yield* loader.entries
					assert.deepStrictEqual(childOf(initial)?.["note"], { text: "keep" })
					yield* loader.update("child", { disabled: true })
					yield* loader.update("child", { note: { text: "updated" } })
					const persisted = yield* fs.readFileString(file)
					assert.include(persisted, "# handwritten metadata")
					assert.deepStrictEqual(childOf(parse(persisted))?.["note"], {
						text: "updated",
					})
					// Force a fresh read while keeping the logical tree unchanged.
					yield* fs.writeFileString(file, `${persisted}\n# reread\n`)
					yield* loader.update("child", { disabled: true })
					const reread = yield* loader.entries
					assert.deepStrictEqual(childOf(reread)?.["note"], { text: "updated" })
					if (nested) assert.strictEqual(reread[0]?.["note"], "parent")
					yield* loader.update("child", { note: undefined })
					const removed = yield* loader.entries
					assert.notProperty(childOf(removed), "note")
				}),
			),
	)
}

it.effect(
	"normalizes empty groups on file reads, creates, and config removal",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, file, loader } = yield* setup(
					"- id: outer\n  name: group\n  group: true\n",
				)
				const initial = yield* loader.entries
				assert.deepStrictEqual(initial[0]?.config, [])
				yield* loader.create(
					{ id: "inner", name: "group", group: true, note: "keep" },
					{ parent: "outer" },
				)
				yield* loader.ready
				const created = yield* loader.entries
				assert.deepStrictEqual(created[0]?.config, [
					{ id: "inner", name: "group", group: true, config: [], note: "keep" },
				])
				yield* loader.update("outer", { config: undefined })
				yield* loader.ready
				const emptied = yield* loader.entries
				assert.deepStrictEqual(emptied[0]?.config, [])
				const disk = yield* fs.readFileString(file)
				assert.notProperty(parse(disk)[0], "config")
			}),
		),
)

it.effect(
	"retains in-memory metadata while normalizing nested empty groups",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{
						id: "outer",
						name: "group",
						group: true,
						note: "parent",
						config: [
							{ id: "inner", name: "group", group: true, note: "child" },
						],
					},
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.update("inner", { note: "updated" })
				const entries = yield* loader.entries
				assert.strictEqual(entries[0]?.["note"], "parent")
				assert.deepStrictEqual(entries[0]?.config, [
					{
						id: "inner",
						name: "group",
						group: true,
						note: "updated",
						config: [],
					},
				])
			}),
		),
)

it("validates known fields at every depth despite accepting metadata", () => {
	expectTypeOf<Entry.NewEntry>().toExtend<{ readonly name: string }>()
	expectTypeOf<Tree.Patch["disabled"]>().toEqualTypeOf<boolean | undefined>()
	expectTypeOf<Tree.Patch["id"]>().toEqualTypeOf<undefined>()
	for (const bad of [
		{ id: "child", name: "unused", disabled: "yes", note: "keep" },
		{ id: "child", name: "group", group: true, config: null },
		{ id: "child", note: "missing name" },
	]) {
		const result = Tree.validate([
			{ id: "outer", name: "group", group: true, config: [bad] },
		])
		assert(Result.isFailure(result))
		assert.strictEqual(result.failure._tag, "InvalidOperation")
		assert.isDefined(result.failure.cause)
	}
})

it.effect("rejects malformed nested fields before writing assigned ids", () =>
	run(() => ({}))(() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = `${directory}/graft.yml`
			const text =
				"- name: group\n  group: true\n  config:\n    - name: unused\n      disabled: invalid\n      note: keep\n"
			yield* fs.writeFileString(file, text)
			const included = yield* Graft.plugin(Include.Include, { path: file })
			const error = yield* Effect.flip(included.await)
			assert.strictEqual(error._tag, "InvalidOperation")
			const disk = yield* fs.readFileString(file)
			assert.strictEqual(disk, text)
		}),
	),
)
