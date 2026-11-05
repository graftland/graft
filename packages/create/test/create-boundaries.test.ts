import {
	Effect,
	Exit,
	FileSystem,
	Path,
	PlatformError,
	String,
	type Scope,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { create } from "../src/index.ts"

const run = <A, E>(
	effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped()
	return { fs, path, root, directory: path.join(root, "example") }
})

describe("create boundaries", () => {
	it.effect(
		"rejects invalid names without creating a target or staging directory",
		() =>
			Effect.gen(function* () {
				const { fs, root, directory } = yield* setup
				for (const name of [
					"node_modules",
					"favicon.ico",
					"app\n",
					"@scope/app\n",
					"~app",
					"UPPER",
					".hidden",
					"@scope/../bad",
					String.repeat(215)("a"),
				]) {
					const exit = yield* Effect.exit(create({ directory, name }))
					assert(Exit.isFailure(exit), name)
					const observed1 = yield* fs.readDirectory(root)

					assert.deepStrictEqual(observed1, [])
				}
			}).pipe(run),
	)

	it.effect("refuses an existing regular file without changing its bytes", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			yield* fs.writeFileString(directory, "keep me")
			const exit = yield* Effect.exit(create({ directory }))
			assert(Exit.isFailure(exit))
			const observed2 = yield* fs.readFileString(directory)

			assert.strictEqual(observed2, "keep me")
		}).pipe(run),
	)

	it.effect(
		"cleans staging after a write failure and preserves the existing empty target",
		() =>
			Effect.gen(function* () {
				const { fs, path, root, directory } = yield* setup
				yield* fs.makeDirectory(directory)
				const exit = yield* Effect.exit(
					create({ directory }).pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							writeFileString: (file, content, options) =>
								String.endsWith("graft.yml")(file)
									? Effect.fail(
											PlatformError.systemError({
												_tag: "PermissionDenied",
												module: "FileSystem",
												method: "writeFileString",
												pathOrDescriptor: file,
											}),
										)
									: fs.writeFileString(file, content, options),
						}),
					),
				)
				assert(Exit.isFailure(exit))
				const observed3 = yield* fs.readDirectory(root)

				assert.deepStrictEqual(observed3, [path.basename(directory)])
				const observed4 = yield* fs.readDirectory(directory)

				assert.deepStrictEqual(observed4, [])
			}).pipe(run),
	)

	it.effect(
		"preserves a target populated by another writer while staging",
		() =>
			Effect.gen(function* () {
				const { fs, path, root, directory } = yield* setup
				yield* fs.makeDirectory(directory)
				const keep = path.join(directory, "keep.txt")
				const exit = yield* Effect.exit(
					create({ directory }).pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							rename: (from, to) =>
								fs
									.writeFileString(keep, "concurrent content")
									.pipe(Effect.andThen(fs.rename(from, to))),
						}),
					),
				)
				assert(Exit.isFailure(exit))
				const observed6 = yield* fs.readFileString(keep)

				assert.strictEqual(observed6, "concurrent content")
				const observed7 = yield* fs.readDirectory(root)

				assert.deepStrictEqual(observed7, ["example"])
				const observed8 = yield* fs.readDirectory(directory)

				assert.deepStrictEqual(observed8, ["keep.txt"])
			}).pipe(run),
	)
})
