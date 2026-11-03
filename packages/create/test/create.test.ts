import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Entry } from "@nmnmcc/graft-loader"
import { Effect, Exit, FileSystem, Path, Schema } from "effect"
import type { Scope } from "effect"
import { parse } from "yaml"
import { create } from "../src/index.ts"
const run = <A, E>(
	effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped()
	const directory = path.join(root, "example")
	return { fs, path, root, directory }
})
describe("create", () => {
	it.effect("generates a loader-compatible project with an ESM example", () =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* setup
			const result = yield* create({ directory, packageManager: "pnpm@9.15.9" })
			assert.strictEqual(result.name, "example")
			const yaml = yield* fs.readFileString(path.join(directory, "graft.yml"))
			const entries = yield* Schema.decodeUnknownEffect(
				Schema.Array(Entry.Entry),
			)(parse(yaml))
			assert.deepStrictEqual(entries, [
				{
					id: "hello",
					name: "./hello.mjs",
					config: { message: "Hello from Graft!" },
				},
			])
			const manifest = yield* fs
				.readFileString(path.join(directory, "package.json"))
				.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown)),
					),
				)
			assert.deepStrictEqual(manifest, {
				name: "example",
				version: "0.0.0",
				private: true,
				type: "module",
				packageManager: "pnpm@9.15.9",
				scripts: { start: "graft start" },
				dependencies: {
					"@nmnmcc/graft": "0.0.0",
					"@nmnmcc/graft-cli": "0.0.0",
					effect: "4.1.2",
				},
			})
			const observed1 = yield* fs.exists(path.join(directory, "hello.mjs"))
			assert.strictEqual(observed1, true)
		}).pipe(run),
	)
	it.effect("accepts an existing empty directory and version overrides", () =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* setup
			yield* fs.makeDirectory(directory)
			yield* create({
				directory,
				name: "@example/app",
				versions: { graft: "file:../core", cli: "file:../cli" },
			})
			const manifest = yield* fs
				.readFileString(path.join(directory, "package.json"))
				.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.fromJsonString(
								Schema.Struct({
									name: Schema.String,
									dependencies: Schema.Record(Schema.String, Schema.String),
								}),
							),
						),
					),
				)
			assert.strictEqual(manifest.name, "@example/app")
			assert.strictEqual(manifest.dependencies["@nmnmcc/graft"], "file:../core")
		}).pipe(run),
	)
	it.effect("refuses nonempty targets without touching their contents", () =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* setup
			yield* fs.makeDirectory(directory)
			const keep = path.join(directory, "keep.txt")
			yield* fs.writeFileString(keep, "keep me")
			const observed2 = yield* Effect.exit(create({ directory }))
			assert(Exit.isFailure(observed2))
			const observed3 = yield* fs.readDirectory(directory)
			assert.deepStrictEqual(observed3, ["keep.txt"])
			const observed4 = yield* fs.readFileString(keep)
			assert.strictEqual(observed4, "keep me")
		}).pipe(run),
	)
	it.effect("validates names before creating files", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			const observed5 = yield* Effect.exit(
				create({ directory, name: "../bad" }),
			)
			assert(Exit.isFailure(observed5))
			const observed6 = yield* fs.exists(directory)
			assert.strictEqual(observed6, false)
		}).pipe(run),
	)
})
