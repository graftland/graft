import {
	Array,
	Effect,
	Exit,
	FileSystem,
	Logger,
	MutableList,
	Path,
	Schema,
	String,
	type Scope,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { Entry } from "@graftland/loader"

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
const readText = (file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(file)
	})
const readJson = (file: string) =>
	Effect.flatMap(
		readText(file),
		Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown)),
	)
/** Generated apps pin Graft packages to this package's own release version. */
const release = Effect.map(
	readText(new URL("../package.json", import.meta.url).pathname),
	(text) =>
		Schema.decodeUnknownSync(
			Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
		)(text).version,
)
const readConfig = (file: string) =>
	Effect.flatMap(readText(file), (yaml) =>
		Schema.decodeUnknownEffect(Schema.Array(Entry.Entry))(parse(yaml)).pipe(
			Effect.map((entries) => ({ yaml, entries })),
		),
	)
/** Runs an effect, collecting the messages of the warnings it logs. */
const warnings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const logs = MutableList.make<string>()
		const result = yield* effect.pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((entry) => {
						if (entry.logLevel === "Warn")
							MutableList.append(logs, `${Array.ensure(entry.message)[0]}`)
					}),
				]),
			),
		)
		return { result, warnings: MutableList.toArray(logs) }
	})
const schemaComment = "# yaml-language-server: $schema=./graft.schema.json"

describe("create", () => {
	it.effect("generates a TypeScript app that the loader accepts", () =>
		Effect.gen(function* () {
			const { path, directory } = yield* setup
			const result = yield* create({ directory, packageManager: "pnpm@9.15.9" })
			assert.strictEqual(result.name, "example")
			assert.strictEqual(result.template, "app")
			const greeter = yield* readText(path.join(directory, "src/greeter.ts"))
			assert.include(greeter, `()("example/greeter")`)
			assert.include(greeter, `name: "example/greeter"`)
			assert.deepStrictEqual(result.files, [
				".gitignore",
				".vscode/extensions.json",
				"README.md",
				"README.zh-CN.md",
				"README.zh-TW.md",
				"graft.yml",
				"package.json",
				"src/greeter.ts",
				"src/hello.ts",
				"src/ticker.ts",
				"tsconfig.build.json",
				"tsconfig.json",
			])
			const { yaml, entries } = yield* readConfig(
				path.join(directory, "graft.yml"),
			)
			assert.strictEqual(String.split("\n")(yaml)[0], schemaComment)
			assert.deepStrictEqual(entries, [
				{
					id: "hello",
					name: "./dist/hello.js",
					config: { message: "Hello from Graft!" },
				},
				{
					id: "greeter",
					name: "./dist/greeter.js",
					config: { greeting: "Hello" },
				},
				{
					id: "ticker",
					name: "./dist/ticker.js",
					config: { name: "Graft" },
				},
			])
			const version = yield* release
			const manifest = yield* readJson(path.join(directory, "package.json"))
			assert.deepStrictEqual(manifest, {
				name: "example",
				version: "0.0.0",
				packageManager: "pnpm@9.15.9",
				private: true,
				type: "module",
				engines: { node: ">=22.19.0" },
				scripts: {
					start: "graft start",
					build: "tsc -p tsconfig.build.json",
					dev: "tsc -p tsconfig.build.json && (tsc -p tsconfig.build.json --watch --preserveWatchOutput & graft start --watch)",
					typecheck: "effect-tsgo tsc",
				},
				dependencies: {
					"@graftland/graft": version,
					"@graftland/loader": version,
					"@graftland/cli": version,
					effect: "4.1.2",
				},
				devDependencies: {
					"@effect/tsgo": "^0.64.1",
					"@types/node": "^22.0.0",
					typescript: "^7.0.2",
				},
			})
		}).pipe(run),
	)

	it.effect("generates a plugin package named for short-name loading", () =>
		Effect.gen(function* () {
			const { path, directory } = yield* setup
			const { result, warnings: logged } = yield* warnings(
				create({ directory, template: "plugin" }),
			)
			assert.strictEqual(result.name, "graft-plugin-example")
			assert.deepStrictEqual(logged, [])
			const plugin = yield* readText(path.join(directory, "src/index.ts"))
			assert.include(plugin, `name: "graft-plugin-example"`)
			assert.deepStrictEqual(result.files, [
				".gitignore",
				".vscode/extensions.json",
				"README.md",
				"README.zh-CN.md",
				"README.zh-TW.md",
				"graft.yml",
				"package.json",
				"src/index.ts",
				"test/index.test.ts",
				"tsconfig.build.json",
				"tsconfig.json",
			])
			const { entries } = yield* readConfig(path.join(directory, "graft.yml"))
			assert.deepStrictEqual(entries, [
				{ id: "greeter", name: "./dist/index.js", config: { name: "Graft" } },
			])
			const version = yield* release
			const manifest = yield* readJson(path.join(directory, "package.json"))
			assert.deepInclude(manifest, {
				name: "graft-plugin-example",
				keywords: ["graft-plugin"],
				exports: {
					".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
				},
				files: ["dist"],
				peerDependencies: {
					"@graftland/graft": `^${version}`,
					effect: "~4.1.2",
				},
			})
			const ignored = yield* readText(path.join(directory, ".gitignore"))
			assert.include(ignored, "dist/")
		}).pipe(run),
	)

	it.effect(
		"keeps a plugin directory's prefix and warns about other names",
		() =>
			Effect.gen(function* () {
				const { path, root } = yield* setup
				const prefixed = yield* create({
					directory: path.join(root, "graft-plugin-hello"),
					template: "plugin",
				})
				assert.strictEqual(prefixed.name, "graft-plugin-hello")
				const scoped = yield* warnings(
					create({
						directory: path.join(root, "official"),
						template: "plugin",
						name: "@graftland/plugin-official",
					}),
				)
				assert.deepStrictEqual(scoped.warnings, [])
				const other = yield* warnings(
					create({
						directory: path.join(root, "other"),
						template: "plugin",
						name: "@acme/greeter",
					}),
				)
				assert.strictEqual(other.warnings.length, 1)
				assert.include(other.warnings[0], "@acme/greeter")
			}).pipe(run),
	)

	it.effect("generates a minimal project with an empty config", () =>
		Effect.gen(function* () {
			const { path, directory } = yield* setup
			const result = yield* create({ directory, template: "minimal" })
			assert.deepStrictEqual(result.files, [
				".gitignore",
				"graft.yml",
				"package.json",
			])
			const { yaml, entries } = yield* readConfig(
				path.join(directory, "graft.yml"),
			)
			assert.strictEqual(yaml, `${schemaComment}\n[]\n`)
			assert.deepStrictEqual(entries, [])
			const version = yield* release
			const manifest = yield* readJson(path.join(directory, "package.json"))
			assert.deepInclude(manifest, {
				scripts: { start: "graft start" },
			})
		}).pipe(run),
	)

	it.effect("depends on and loads each plugin", () =>
		Effect.gen(function* () {
			const { path, directory } = yield* setup
			yield* create({
				directory,
				template: "minimal",
				plugins: [
					"@graftland/plugin-review",
					"graft-plugin-echo@^1.2.0",
					"@acme/audit",
				],
			})
			// The loader gives entries without an id one when it first reads the file.
			const text = yield* readText(path.join(directory, "graft.yml"))
			assert.deepStrictEqual(parse(text), [
				{ name: "@graftland/plugin-review" },
				{ name: "graft-plugin-echo" },
				{ name: "@acme/audit" },
			])
			const version = yield* release
			const manifest = yield* readJson(path.join(directory, "package.json"))
			assert.deepInclude(manifest, {
				dependencies: {
					"@graftland/graft": version,
					"@graftland/loader": version,
					"@graftland/cli": version,
					effect: "4.1.2",
					"@graftland/plugin-review": version,
					"graft-plugin-echo": "^1.2.0",
					"@acme/audit": "latest",
				},
			})
			const app = path.join(path.dirname(directory), "app")
			yield* create({ directory: app, plugins: ["@graftland/plugin-review"] })
			const appText = yield* readText(path.join(app, "graft.yml"))
			assert.deepStrictEqual(parse(appText), [
				{
					id: "hello",
					name: "./dist/hello.js",
					config: { message: "Hello from Graft!" },
				},
				{
					id: "greeter",
					name: "./dist/greeter.js",
					config: { greeting: "Hello" },
				},
				{
					id: "ticker",
					name: "./dist/ticker.js",
					config: { name: "Graft" },
				},
				{ name: "@graftland/plugin-review" },
			])
		}).pipe(run),
	)

	it.effect("rejects an invalid plugin before creating files", () =>
		Effect.gen(function* () {
			const { fs, root, directory } = yield* setup
			const exit = yield* Effect.exit(
				create({ directory, plugins: ["Not Valid"] }),
			)
			assert(Exit.isFailure(exit))
			const observed = yield* fs.readDirectory(root)
			assert.deepStrictEqual(observed, [])
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
			assert.strictEqual(
				manifest.dependencies["@graftland/graft"],
				"file:../core",
			)
		}).pipe(run),
	)

	it.effect("generates beside a repository's .git without touching it", () =>
		Effect.gen(function* () {
			const { fs, path, root, directory } = yield* setup
			yield* fs.makeDirectory(path.join(directory, ".git"), {
				recursive: true,
			})
			const head = path.join(directory, ".git", "HEAD")
			yield* fs.writeFileString(head, "ref: refs/heads/main\n")
			yield* fs.writeFileString(path.join(directory, ".DS_Store"), "")
			const result = yield* create({ directory, template: "minimal" })
			const observed = yield* fs.readDirectory(directory)
			assert.deepStrictEqual(Array.sort(observed, String.Order), [
				".DS_Store",
				".git",
				".gitignore",
				"graft.yml",
				"package.json",
			])
			assert.deepStrictEqual(result.files, [
				".gitignore",
				"graft.yml",
				"package.json",
			])
			const kept = yield* fs.readFileString(head)
			assert.strictEqual(kept, "ref: refs/heads/main\n")
			const siblings = yield* fs.readDirectory(root)
			assert.deepStrictEqual(siblings, ["example"])
		}).pipe(run),
	)

	it.effect("refuses nonempty targets without touching their contents", () =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* setup
			yield* fs.makeDirectory(path.join(directory, ".git"), {
				recursive: true,
			})
			const keep = path.join(directory, "keep.txt")
			yield* fs.writeFileString(keep, "keep me")
			const observed2 = yield* Effect.exit(create({ directory }))
			assert(Exit.isFailure(observed2))
			const observed3 = yield* fs.readDirectory(directory)
			assert.deepStrictEqual(Array.sort(observed3, String.Order), [
				".git",
				"keep.txt",
			])
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
