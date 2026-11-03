import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Path, Schema, String } from "effect"
import { create } from "../src/index.ts"

it.effect(
	"rejects invalid package manager declarations before creating any files",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const root = yield* fs.makeTempDirectoryScoped()
			for (const packageManager of [
				"pnpm@9.15.9-",
				"pnpm@9.15.9+",
				"pnpm@9.15.9-rc..1",
				"pnpm@09.15.9",
				"pnpm@9.15.9-01",
				"yarn@4.0.0+build.1",
				"npm@11.0.0+sha512.abc",
				"pnpm@9.15.9-rc.1\n",
			]) {
				const exit = yield* Effect.exit(
					create({ directory: path.join(root, "example"), packageManager }),
				)
				assert(Exit.isFailure(exit), packageManager)
				const entries = yield* fs.readDirectory(root)
				assert.deepStrictEqual(entries, [], packageManager)
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"preserves exact prerelease and Corepack hash declarations in generated manifests",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const root = yield* fs.makeTempDirectoryScoped()
			for (const [name, packageManager] of [
				["stable", "pnpm@9.15.9"],
				["prerelease", "yarn@4.0.0-rc.1"],
				["hashed", `pnpm@9.15.9+sha512.${String.repeat(128)("a")}`],
			] as const) {
				const directory = path.join(root, name)
				yield* create({ directory, packageManager })
				const text = yield* fs.readFileString(
					path.join(directory, "package.json"),
				)
				const manifest = yield* Schema.decodeEffect(
					Schema.fromJsonString(
						Schema.Struct({ packageManager: Schema.String }),
					),
				)(text)
				assert.strictEqual(manifest.packageManager, packageManager)
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
