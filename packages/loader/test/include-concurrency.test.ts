import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Option,
	pipe,
	PlatformError,
	Ref,
	Schema,
	String,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Include } from "../src/index.ts"
import { WriteConflict } from "../src/internal/atomicWrite.ts"
import { loaderService, run } from "./utils.ts"

const original =
	"- id: a\n  name: unused\n  disabled: true\n  note: original\n  config: before\n"
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	return { fs, directory, file: `${directory}/graft.yml` }
})

it.effect.each([false, true])(
	"rebases an overlapping save (same field: %s)",
	(sameField) =>
		run()(() =>
			Effect.gen(function* () {
				const { fs, directory, file } = yield* setup
				yield* fs.writeFileString(file, original)
				const prepared = yield* Deferred.make<void>()
				const resume = yield* Deferred.make<void>()
				const attempts = yield* Ref.make(0)
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					open: (path, options) =>
						Effect.map(fs.open(path, options), (handle) => ({
							...handle,
							stat: handle.stat,
							writeAll: (bytes) => handle.writeAll(bytes),
							sync: handle.sync.pipe(
								Effect.andThen(
									Effect.gen(function* () {
										const attempt = yield* Ref.updateAndGet(
											attempts,
											(n) => n + 1,
										)
										if (attempt === 1) {
											yield* Deferred.succeed(prepared, undefined)
											yield* Deferred.await(resume)
										}
									}),
								),
							),
						})),
				})
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				const editing = yield* loader
					.update("a", { config: "API edit" })
					.pipe(Effect.forkChild)
				yield* Deferred.await(prepared)
				const external = pipe(
					original,
					String.replace("note: original", "note: external"),
					String.replace(
						"config: before",
						sameField ? "config: external" : "config: before",
					),
				)
				yield* fs.writeFileString(file, external)
				yield* Deferred.succeed(resume, undefined)
				yield* Fiber.join(editing)
				const text = yield* fs.readFileString(file)
				const entries = yield* loader.entries
				const names = yield* fs.readDirectory(directory)
				const count = yield* Ref.get(attempts)
				assert.include(text, "note: external")
				assert.include(text, `config: ${sameField ? "external" : "API edit"}`)
				assert.strictEqual(
					entries[0]?.config,
					sameField ? "external" : "API edit",
				)
				assert.strictEqual(count, sameField ? 1 : 2)
				assert.deepStrictEqual(names, ["graft.yml"])
			}),
		),
)

it.effect(
	"bounds rebase attempts and remains editable after contention stops",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const { fs, directory, file } = yield* setup
				yield* fs.writeFileString(file, original)
				const attempts = yield* Ref.make(0)
				const competing = yield* Ref.make(true)
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					open: (path, options) =>
						Effect.map(fs.open(path, options), (handle) => ({
							...handle,
							stat: handle.stat,
							writeAll: (bytes) => handle.writeAll(bytes),
							sync: handle.sync.pipe(
								Effect.andThen(
									Effect.gen(function* () {
										const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
										if (yield* Ref.get(competing))
											yield* fs.writeFileString(
												file,
												pipe(
													original,
													String.replace(
														"note: original",
														`note: external ${n}`,
													),
												),
											)
									}),
								),
							),
						})),
				})
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				const exit = yield* Effect.exit(
					loader.update("a", { config: "API edit" }),
				)
				assert(Exit.isFailure(exit))
				const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
				assert(error._tag === "StoreError")
				assert(Schema.is(WriteConflict)(error.cause))
				const count = yield* Ref.get(attempts)
				const names = yield* fs.readDirectory(directory)
				assert.strictEqual(count, 3)
				assert.deepStrictEqual(names, ["graft.yml"])
				yield* Ref.set(competing, false)
				yield* loader.update("a", { config: "recovered" })
				const text = yield* fs.readFileString(file)
				assert.include(text, "note: external 3")
				assert.include(text, "config: recovered")
			}),
		),
)

it.effect.each(["creation", "anonymous IDs"])(
	"rebases an overlapping save during %s",
	(stage) =>
		run()(() =>
			Effect.gen(function* () {
				const { fs, directory, file } = yield* setup
				const anonymous = pipe(
					original,
					String.replace("- id: a\n  name", "- name"),
				)
				if (stage === "anonymous IDs")
					yield* fs.writeFileString(file, anonymous)
				const first = yield* Ref.make(true)
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					open: (path, options) =>
						Effect.map(fs.open(path, options), (handle) => ({
							...handle,
							stat: handle.stat,
							writeAll: (bytes) => handle.writeAll(bytes),
							sync: handle.sync.pipe(
								Effect.andThen(
									Effect.gen(function* () {
										if (yield* Ref.getAndSet(first, false))
											yield* fs.writeFileString(
												file,
												pipe(
													anonymous,
													String.replace("note: original", "note: external"),
												),
											)
									}),
								),
							),
						})),
				})
				const fork = yield* Graft.plugin(Include.Include, {
					path: file,
					initial: [],
				})
				yield* fork.await
				const loader = yield* loaderService
				const entries = yield* loader.entries
				const text = yield* fs.readFileString(file)
				const names = yield* fs.readDirectory(directory)
				assert.strictEqual(entries.length, 1)
				assert.isString(entries[0]?.id)
				assert.include(text, "note: external")
				assert.deepStrictEqual(names, ["graft.yml"])
			}),
		),
)

it.effect(
	"does not retry away a cleanup failure accompanying a version conflict",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const { fs, file } = yield* setup
				yield* fs.writeFileString(file, original)
				const attempts = yield* Ref.make(0)
				const cleanup = PlatformError.systemError({
					_tag: "Unknown",
					module: "FileSystem",
					method: "remove",
				})
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					open: (path, options) =>
						Effect.map(fs.open(path, options), (handle) => ({
							...handle,
							stat: handle.stat,
							writeAll: (bytes) => handle.writeAll(bytes),
							sync: handle.sync.pipe(
								Effect.andThen(Ref.update(attempts, (n) => n + 1)),
								Effect.andThen(
									fs.writeFileString(
										file,
										pipe(original, String.replace("original", "external")),
									),
								),
							),
						})),
					remove: () => Effect.fail(cleanup),
				})
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				const exit = yield* Effect.exit(
					loader.update("a", { config: "API edit" }),
				)
				assert(Exit.isFailure(exit))
				assert.strictEqual(exit.cause.reasons.length, 2)
				assert.isTrue(
					Array.some(
						exit.cause.reasons,
						(reason) => Cause.isFailReason(reason) && reason.error === cleanup,
					),
				)
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 1)
			}),
		),
)
