import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Path,
	Option,
	PlatformError,
	Ref,
} from "effect"
import { Include } from "../src/index.ts"
import { atomicWrite } from "../src/internal/atomicWrite.ts"
import { loaderService, run } from "./utils.ts"

const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = path.join(directory, "graft.yml")
	return { fs, directory, file }
})
const failure = (method: string) =>
	PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method })

describe("scoped atomic writes", () => {
	it.effect(
		"does not commit if the original ownership cannot be preserved",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fs, directory, file } = yield* setup
					yield* fs.writeFileString(file, "original")
					const ownership = failure("chown")
					const result = yield* atomicWrite(file, "replacement").pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							stat: (path) =>
								fs.stat(path).pipe(
									Effect.map((info) =>
										path === file
											? {
													...info,
													uid: Option.map(info.uid, (uid) => uid + 1),
												}
											: info,
									),
								),
							chown: () => Effect.fail(ownership),
						}),
						Effect.exit,
					)
					assert(Exit.isFailure(result))
					assert.strictEqual(Cause.squash(result.cause), ownership)
					const text = yield* fs.readFileString(file)
					const names = yield* fs.readDirectory(directory)
					assert.strictEqual(text, "original")
					assert.deepStrictEqual(names, ["graft.yml"])
				}),
			),
	)
	it.effect("retains interruption and cleanup failure together", () =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, file } = yield* setup
				const entered = yield* Deferred.make<void>()
				const cleanup = failure("cleanup")
				const writing = yield* atomicWrite(
					file,
					"replacement",
					undefined,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				).pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						remove: () => Effect.fail(cleanup),
					}),
					Effect.forkChild,
				)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(writing)
				const result = yield* Fiber.await(writing)
				assert(Exit.isFailure(result))
				assert.isTrue(Cause.hasInterrupts(result.cause))
				assert.strictEqual(
					Option.getOrThrow(Cause.findErrorOption(result.cause)),
					cleanup,
				)
			}),
		),
	)
	for (const mode of [0o600, 0o640, 0o644]) {
		it.effect(`preserves existing permission bits ${mode.toString(8)}`, () =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fs, directory, file } = yield* setup
					yield* fs.writeFileString(
						file,
						"- id: a\n  name: unused\n  disabled: true\n",
					)
					yield* fs.chmod(file, mode)
					yield* Graft.plugin(Include.Include, { path: file })
					const loader = yield* loaderService
					yield* loader.update("a", { config: { token: "private" } })
					const info = yield* fs.stat(file)
					assert.strictEqual(info.mode & 0o7777, mode)
					const names = yield* fs.readDirectory(directory)
					assert.deepStrictEqual(names, ["graft.yml"])
				}),
			),
		)
	}

	it.effect(
		"creates initial files privately and syncs data before rename",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fs, file } = yield* setup
					const synced = yield* Ref.make(false)
					yield* Graft.provide(FileSystem.FileSystem, {
						...fs,
						open: (path, options) =>
							Effect.gen(function* () {
								assert.strictEqual(options?.flag, "wx")
								assert.strictEqual(options?.mode, 0o600)
								const handle = yield* fs.open(path, options)
								const info = yield* handle.stat
								assert.strictEqual(info.mode & 0o077, 0)
								return {
									...handle,
									writeAll: (bytes) => handle.writeAll(bytes),
									sync: handle.sync.pipe(Effect.andThen(Ref.set(synced, true))),
								}
							}),
						rename: (source, target) =>
							Effect.gen(function* () {
								const done = yield* Ref.get(synced)
								assert.isTrue(done)
								yield* fs.rename(source, target)
							}),
					})
					const fork = yield* Graft.plugin(Include.Include, { path: file })
					yield* fork.await
					const info = yield* fs.stat(file)
					assert.strictEqual(info.mode & 0o777, 0o600)
				}),
			),
	)

	for (const stage of ["partial write", "sync", "rename"] as const) {
		it.effect(`removes its temporary file after a ${stage} failure`, () =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fs, directory, file } = yield* setup
					yield* fs.writeFileString(file, "original")
					const error = failure(stage)
					const result = yield* atomicWrite(file, "replacement").pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							open: (path, options) =>
								Effect.map(fs.open(path, options), (handle) => ({
									...handle,
									stat: handle.stat,
									writeAll: (bytes) =>
										stage === "partial write"
											? handle
													.writeAll(bytes.subarray(0, 2))
													.pipe(Effect.andThen(Effect.fail(error)))
											: handle.writeAll(bytes),
									sync: stage === "sync" ? Effect.fail(error) : handle.sync,
								})),
							rename: stage === "rename" ? () => Effect.fail(error) : fs.rename,
						}),
						Effect.exit,
					)
					assert(Exit.isFailure(result))
					assert.strictEqual(Cause.squash(result.cause), error)
					const names = yield* fs.readDirectory(directory)
					const text = yield* fs.readFileString(file)
					assert.deepStrictEqual(names, ["graft.yml"])
					assert.strictEqual(text, "original")
				}),
			),
		)
	}

	it.effect(
		"removes its temporary file when Include closes during an edit",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fs, directory, file } = yield* setup
					yield* fs.writeFileString(
						file,
						"- id: a\n  name: unused\n  disabled: true\n",
					)
					const entered = yield* Deferred.make<void>()
					const temporaryOpened = yield* Ref.make(false)
					yield* Graft.provide(FileSystem.FileSystem, {
						...fs,
						open: (path, options) =>
							fs
								.open(path, options)
								.pipe(Effect.tap(() => Ref.set(temporaryOpened, true))),
						realPath: (path) =>
							Ref.get(temporaryOpened).pipe(
								Effect.flatMap((editing) =>
									editing
										? Deferred.succeed(entered, undefined).pipe(
												Effect.andThen(Effect.never),
											)
										: fs.realPath(path),
								),
							),
					})
					const fork = yield* Graft.plugin(Include.Include, { path: file })
					const loader = yield* loaderService
					const editing = yield* loader
						.update("a", { config: "replacement" })
						.pipe(Effect.forkChild)
					yield* Deferred.await(entered)
					const pending = yield* fs.readDirectory(directory)
					assert.lengthOf(pending, 2)
					yield* fork.dispose
					const exit = yield* Fiber.await(editing)
					assert(Exit.isFailure(exit))
					const names = yield* fs.readDirectory(directory)
					assert.deepStrictEqual(names, ["graft.yml"])
				}),
			),
	)

	it.effect("retains both operation and cleanup failures in the cause", () =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, file } = yield* setup
				const rename = failure("rename")
				const cleanup = failure("cleanup")
				const result = yield* atomicWrite(file, "replacement").pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						rename: () => Effect.fail(rename),
						remove: () => Effect.fail(cleanup),
					}),
					Effect.exit,
				)
				assert(Exit.isFailure(result))
				assert.deepStrictEqual(
					result.cause,
					Cause.combine(Cause.fail(rename), Cause.fail(cleanup)),
				)
			}),
		),
	)

	it.effect(
		"rejects a pre-existing temporary symlink without following or deleting it",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fs, directory, file } = yield* setup
					const victim = `${directory}/victim`
					yield* fs.writeFileString(victim, "untouched")
					const result = yield* atomicWrite(file, "replacement").pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							open: (path, options) =>
								fs
									.symlink(victim, path)
									.pipe(Effect.andThen(fs.open(path, options))),
						}),
						Effect.exit,
					)
					assert(Exit.isFailure(result))
					const text = yield* fs.readFileString(victim)
					const names = yield* fs.readDirectory(directory)
					assert.strictEqual(text, "untouched")
					assert.strictEqual(Array.length(names), 2)
				}),
			),
	)
})

for (const stage of ["write", "rename"]) {
	it.live(
		`waits for accepted native ${stage} completion before cancellation cleanup`,
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fs, file } = yield* setup
					const started = Promise.withResolvers<void>()
					const completion = Promise.withResolvers<void>()
					const native = failure(stage)
					const removed = yield* Ref.make(false)
					const pending = Effect.tryPromise({
						try: () => {
							started.resolve()
							return completion.promise
						},
						catch: () => native,
					})
					const writing = yield* atomicWrite(file, "replacement").pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							open: (path, options) =>
								fs.open(path, options).pipe(
									Effect.map((handle) => ({
										...handle,
										stat: handle.stat,
										sync: handle.sync,
										writeAll: (bytes) =>
											stage === "write" ? pending : handle.writeAll(bytes),
									})),
								),
							rename: stage === "rename" ? () => pending : fs.rename,
							remove: (path, options) =>
								Ref.set(removed, true).pipe(
									Effect.andThen(fs.remove(path, options)),
								),
						}),
						Effect.forkScoped,
					)
					yield* Effect.promise(() => started.promise)
					const cancelling = yield* Fiber.interrupt(writing).pipe(
						Effect.forkScoped,
					)
					yield* Effect.yieldNow
					const premature = yield* Ref.get(removed)
					completion.reject(native)
					yield* Fiber.join(cancelling)
					const result = yield* Fiber.await(writing)
					assert.isFalse(premature)
					assert(Exit.isFailure(result))
					assert.isTrue(Cause.hasInterrupts(result.cause))
					assert.isTrue(
						Array.some(
							result.cause.reasons,
							(reason) => reason._tag === "Fail" && reason.error === native,
						),
					)
					const cleaned = yield* Ref.get(removed)
					assert.isTrue(cleaned)
				}),
			),
	)
}
