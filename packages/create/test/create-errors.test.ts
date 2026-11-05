import {
	Array,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Path,
	PlatformError,
	Schema,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { create, InvalidName, InvalidPackageManager } from "../src/index.ts"

const isInvalidName = Schema.is(InvalidName)
const isInvalidPackageManager = Schema.is(InvalidPackageManager)

it.effect("reports an invalid project name with the rejected name", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = yield* fs.makeTempDirectoryScoped()
		const error = yield* Effect.flip(
			create({ directory: path.join(root, "example"), name: "Not Valid" }),
		)
		if (!isInvalidName(error)) return assert.fail(`Unexpected ${error._tag}`)
		assert.strictEqual(error.packageName, "Not Valid")
		assert.notStrictEqual(error.message, "")
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect("reports an invalid package manager with the rejected value", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = yield* fs.makeTempDirectoryScoped()
		const error = yield* Effect.flip(
			create({
				directory: path.join(root, "example"),
				packageManager: "pnpm@09.15.9",
			}),
		)
		if (!isInvalidPackageManager(error))
			return assert.fail(`Unexpected ${error._tag}`)
		assert.strictEqual(error.value, "pnpm@09.15.9")
		assert.notStrictEqual(error.message, "")
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"treats an unreadable own manifest as a defect, not a target failure",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const root = yield* fs.makeTempDirectoryScoped()
			const error = PlatformError.systemError({
				_tag: "NotFound",
				module: "FileSystem",
				method: "readFileString",
			})
			const exit = yield* Effect.exit(
				create({ directory: path.join(root, "example") }).pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						readFileString: () => Effect.fail(error),
					}),
				),
			)
			assert(Exit.isFailure(exit))
			assert.isFalse(Cause.hasFails(exit.cause))
			assert.deepStrictEqual(
				Array.map(
					Array.filter(exit.cause.reasons, Cause.isDieReason),
					(reason) => reason.defect,
				),
				[error],
			)
			const entries = yield* fs.readDirectory(root)
			assert.deepStrictEqual(entries, [])
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
