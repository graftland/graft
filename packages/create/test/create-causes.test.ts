import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Path,
	PlatformError,
} from "effect"
import { create } from "../src/index.ts"

it.effect("retains a staging write failure and a cleanup defect", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = yield* fs.makeTempDirectoryScoped()
		const directory = path.join(root, "example")
		const error = PlatformError.systemError({
			_tag: "PermissionDenied",
			module: "FileSystem",
			method: "writeFileString",
		})
		const exit = yield* Effect.exit(
			create({ directory }).pipe(
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					writeFileString: () => Effect.fail(error),
					makeTempDirectoryScoped: (options) =>
						Effect.acquireRelease(fs.makeTempDirectory(options), (directory) =>
							fs
								.remove(directory, { recursive: true })
								.pipe(
									Effect.orDie,
									Effect.andThen(Effect.die("cleanup defect")),
								),
						),
				}),
			),
		)
		assert(Exit.isFailure(exit))
		// Effect promotes the write failure to Die when cleanup also defects.
		assert.deepStrictEqual(
			Array.map(
				Array.filter(exit.cause.reasons, Cause.isDieReason),
				(reason) => reason.defect,
			),
			[error, "cleanup defect"],
		)
		const entries = yield* fs.readDirectory(root)
		assert.deepStrictEqual(entries, [])
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
