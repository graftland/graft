import { Array, Effect, Exit, FileSystem, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Entry, Include, Tree } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

it.effect("validates initial entries before committing a new file", () =>
	run(() => ({}))(() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = `${directory}/graft.yml`
			const owner = yield* Graft.plugin(Include.Include, {
				path: file,
				initial: [
					{ id: "duplicate", name: "unused", disabled: true },
					{ id: "duplicate", name: "unused", disabled: true },
				],
			})
			const result = yield* Effect.exit(owner.await)
			assert.isTrue(Exit.isFailure(result))
			const exists = yield* fs.exists(file)
			assert.isFalse(exists, "Invalid initial entries must not be persisted")
		}),
	),
)

it.effect(
	"rejects malformed descendants and cyclic topology without creating a file",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const cyclic: {
					name: string
					group: boolean
					config?: ReadonlyArray<unknown>
				} = { name: "group", group: true }
				cyclic.config = [cyclic]
				const cases = [
					[
						{
							name: "group",
							group: true,
							config: [{ name: "unused", disabled: "invalid" }],
						},
					],
					[cyclic],
				]
				for (const [index, initial] of cases.entries()) {
					const file = `${directory}/invalid-${index}.yml`
					const owner = yield* Graft.plugin(Include.Include, {
						path: file,
						initial,
					})
					const result = yield* Effect.exit(owner.await)
					assert(Exit.isFailure(result))
					const exists = yield* fs.exists(file)
					assert.isFalse(exists)
				}
				const files = yield* fs.readDirectory(directory)
				assert.deepStrictEqual(files, [])
			}),
		),
)

it.effect(
	"commits anonymous initial entries once, with all IDs and original Env tags",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				const commits = yield* Ref.make<ReadonlyArray<string>>([])
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					rename: (source, target) =>
						fs.readFileString(source).pipe(
							Effect.flatMap((text) => Ref.update(commits, Array.append(text))),
							Effect.andThen(fs.rename(source, target)),
						),
				})
				const owner = yield* Graft.plugin(Include.Include, {
					path: file,
					initial: [
						{
							name: "group",
							group: true,
							config: [
								{
									name: "unused",
									disabled: true,
									config: new Entry.Env({ name: "SECRET" }),
								},
							],
						},
					],
				})
				yield* owner.await
				const loader = yield* loaderService
				yield* loader.ready
				const entries = yield* loader.entries
				assert.strictEqual(Tree.ids(entries).length, 2)
				assert.strictEqual(Array.dedupe(Tree.ids(entries)).length, 2)
				const written = yield* Ref.get(commits)
				const disk = yield* fs.readFileString(file)
				assert.deepStrictEqual(written, [disk])
				assert.include(disk, "!env SECRET")
				const files = yield* fs.readDirectory(directory)
				assert.deepStrictEqual(files, ["graft.yml"])
			}),
		),
)

it.effect(
	"keeps an existing file even when the unused initial value is invalid",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				const text = "# Existing configuration\n[]\n"
				yield* fs.writeFileString(file, text)
				const owner = yield* Graft.plugin(Include.Include, {
					path: file,
					initial: [{ name: "unused", disabled: "invalid" }],
				})
				yield* owner.await
				const disk = yield* fs.readFileString(file)
				assert.strictEqual(disk, text)
			}),
		),
)
