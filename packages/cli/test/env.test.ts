import { Config, Effect, Exit, FileSystem, Layer, Option } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { layer as envLayer } from "../src/internal/env.ts"

describe("env directory", () => {
	const variable = (name: string) => Config.String(name).pipe(Effect.option)

	it.effect(
		"reads one variable per visible regular file, after the environment and the env file",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const secrets = `${directory}/secrets`
				yield* fs.makeDirectory(`${secrets}/nested`, { recursive: true })
				yield* fs.writeFileString(`${secrets}/GRAFT_DIR_TOKEN`, "token\r\n\n")
				yield* fs.writeFileString(`${secrets}/GRAFT_DIR_EMPTY`, "")
				yield* fs.writeFileString(`${secrets}/GRAFT_DIR_SHARED`, "dir")
				yield* fs.writeFileString(`${secrets}/.GRAFT_DIR_HIDDEN`, "hidden")
				yield* fs.writeFileString(`${secrets}/nested/GRAFT_DIR_DEEP`, "deep")
				yield* fs.writeFileString(`${directory}/target`, "linked")
				yield* fs.symlink(`${directory}/target`, `${secrets}/GRAFT_DIR_LINK`)
				yield* fs.writeFileString(
					`${directory}/.env`,
					"GRAFT_DIR_SHARED=file\n",
				)
				const values = yield* Effect.all({
					token: variable("GRAFT_DIR_TOKEN"),
					empty: variable("GRAFT_DIR_EMPTY"),
					shared: variable("GRAFT_DIR_SHARED"),
					hidden: variable(".GRAFT_DIR_HIDDEN"),
					deep: variable("GRAFT_DIR_DEEP"),
					link: variable("GRAFT_DIR_LINK"),
				}).pipe(
					Effect.provide(envLayer({ file: `${directory}/.env`, dir: secrets })),
				)
				assert.deepStrictEqual(values, {
					token: Option.some("token"),
					empty: Option.some(""),
					shared: Option.some("file"),
					hidden: Option.none(),
					deep: Option.none(),
					link: Option.some("linked"),
				})
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.effect("fails when the directory is missing", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const exit = yield* Layer.build(
				envLayer({ dir: `${directory}/missing` }),
			).pipe(Effect.scoped, Effect.exit)
			assert(Exit.isFailure(exit))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
