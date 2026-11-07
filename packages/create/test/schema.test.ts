import { Effect, FileSystem, Path } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import * as EditorSchema from "../src/internal/schema.ts"

/** A project whose installed `@graftland/cli` runs the given script as `graft`. */
const project = Effect.fnUntraced(function* (bin: string | undefined) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	yield* fs.writeFileString(
		path.join(directory, "package.json"),
		'{"name":"example","private":true}',
	)
	if (bin !== undefined) {
		const cli = path.join(directory, "node_modules", "@graftland", "cli")
		yield* fs.makeDirectory(path.join(cli, "dist"), { recursive: true })
		yield* fs.writeFileString(
			path.join(cli, "package.json"),
			'{"name":"@graftland/cli","type":"module","bin":{"graft":"./dist/bin.js"}}',
		)
		yield* fs.writeFileString(path.join(cli, "dist", "bin.js"), bin)
	}
	return directory
})

describe("the schema of a new project", () => {
	it.live("is written by the project's own CLI", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* project(
				`import { writeFileSync } from "node:fs"
writeFileSync("graft.schema.json", JSON.stringify(process.argv.slice(2)))`,
			)
			yield* EditorSchema.write(directory)
			const written = yield* fs.readFileString(`${directory}/graft.schema.json`)
			assert.strictEqual(written, '["schema"]')
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("fails with the CLI's output when it fails", () =>
		Effect.gen(function* () {
			const directory = yield* project(
				`console.error("Cannot read package.json"); process.exit(1)`,
			)
			const error = yield* Effect.flip(EditorSchema.write(directory))
			assert.strictEqual(error._tag, "GraftSchemaError")
			assert.strictEqual(error.message, "Cannot read package.json")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("fails when the project does not resolve the CLI", () =>
		Effect.gen(function* () {
			const directory = yield* project(undefined)
			const error = yield* Effect.flip(EditorSchema.write(directory))
			assert.strictEqual(error._tag, "GraftSchemaError")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
