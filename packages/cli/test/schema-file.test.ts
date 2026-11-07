import { Array, Effect, FileSystem, Path, Record, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

const bin = new URL("../.cache/commands/cli/bin.js", import.meta.url).pathname
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const Written = Schema.fromJsonString(
	Schema.Struct({
		definitions: Schema.Struct({
			Entry: Schema.Struct({
				allOf: Schema.Array(
					Schema.Struct({
						if: Schema.Struct({
							properties: Schema.Struct({
								name: Schema.Struct({ enum: Schema.Array(Schema.String) }),
							}),
						}),
						then: Schema.Struct({
							properties: Schema.Struct({ config: Schema.Unknown }),
							required: Schema.optionalKey(Schema.Array(Schema.String)),
						}),
					}),
				),
			}),
		}),
	}),
)

/** An installed package: its `./schema` module and changes to a plugin's manifest. */
interface Installed {
	readonly schema: string
	readonly manifest?: object
}

/** Runs `graft schema` in a project with the given packages installed. */
const run = Effect.fnUntraced(function* (packages: Record<string, Installed>) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const project = yield* encode({
		dependencies: Record.map(packages, () => "1.0.0"),
		devDependencies: { "graft-plugin-missing": "1.0.0" },
	})
	yield* fs.writeFileString(path.join(directory, "package.json"), project)
	for (const [name, { schema, manifest }] of Record.toEntries(packages)) {
		const root = path.join(directory, "node_modules", name)
		const text = yield* encode({
			type: "module",
			exports: { ".": "./index.js", "./schema": "./schema.js" },
			peerDependencies: { "@graftland/graft": "^0.4.0" },
			...manifest,
		})
		yield* fs.makeDirectory(root, { recursive: true })
		yield* fs.writeFileString(path.join(root, "package.json"), text)
		yield* fs.writeFileString(path.join(root, "schema.js"), schema)
		yield* fs.writeFileString(
			path.join(root, "index.js"),
			`throw new Error("The plugin was loaded")`,
		)
	}
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const child = yield* spawner.spawn(
		ChildProcess.make(process.execPath, [bin, "schema"], {
			cwd: directory,
			// Leaves out the command plugins of the user running the tests.
			env: { GRAFT_HOME: path.join(directory, ".graft") },
			extendEnv: true,
		}),
	)
	const output = yield* child.all.pipe(
		Stream.decodeText(),
		Stream.runCollect,
		Effect.map((parts) => Array.join(parts, "")),
	)
	const code = yield* child.exitCode
	return { directory, output, code }
})

describe("graft schema", () => {
	it.live(
		"composes the ./schema of plugin packages without loading the plugins",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const { directory, output, code } = yield* run({
					"graft-plugin-postgres": {
						schema: `export const entries = () => [{ names: ["postgres", "graft-plugin-postgres"], schema: { type: "object" }, required: true }]`,
					},
					// Like effect, which exports a ./schema that is not a registration.
					lookalike: {
						schema: `throw new Error("Not a plugin package")`,
						manifest: { peerDependencies: {} },
					},
				})
				assert.strictEqual(code, 0, output)
				assert.include(output, "graft-plugin-missing is not installed")
				const text = yield* fs.readFileString(`${directory}/graft.schema.json`)
				const written = yield* Schema.decodeEffect(Written)(text)
				assert.deepStrictEqual(written.definitions.Entry.allOf, [
					{
						if: {
							properties: {
								name: { enum: ["postgres", "graft-plugin-postgres"] },
							},
						},
						then: {
							properties: { config: { type: "object" } },
							required: ["config"],
						},
					},
				])
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live(
		"fails, naming the package, when ./schema is not a registration",
		() =>
			Effect.gen(function* () {
				const { directory, output, code } = yield* run({
					"graft-plugin-broken": {
						schema: `export const entries = () => [{ names: "broken" }]`,
					},
				})
				const fs = yield* FileSystem.FileSystem
				assert.strictEqual(code, 1, output)
				assert.include(output, "graft-plugin-broken/schema")
				const written = yield* fs.exists(`${directory}/graft.schema.json`)
				assert.isFalse(written)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
