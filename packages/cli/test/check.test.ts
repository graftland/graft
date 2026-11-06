import { Effect, FileSystem, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Manifest } from "@graftland/graft"

import * as Check from "../src/Check"

const pkg: Manifest.Package = {
	name: "independent-plugin",
	version: "1.0.0",
	engines: { node: ">=22.19.0" },
	peerDependencies: { effect: "4.1.*", "@graftland/graft": "0.0.0" },
	graft: {
		version: 1,
		entries: {
			".": {
				implementation: "index.js",
				contracts: [],
				requirements: {
					placements: ["Worker"],
					filesystem: false,
					nativeModules: false,
				},
				probes: [],
				services: { required: [], optional: [], implements: [] },
				operations: [],
			},
		},
	},
}
const setup = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.makeTempDirectoryScoped()
	yield* fs.makeDirectory(root + "/plugin")
	const text = yield* Schema.encodeEffect(
		Schema.fromJsonString(Manifest.Package),
	)(pkg)
	yield* fs.writeFileString(root + "/plugin/package.json", text)
	yield* fs.writeFileString(
		root + "/plugin/index.js",
		'throw new Error("Implementation must not be imported")',
	)
	const config: Check.Configuration = {
		host: {
			node: "22.22.0",
			effect: "4.1.2",
			graft: "0.0.0",
			placement: "Worker",
			filesystem: false,
			nativeModules: false,
			operations: [],
		},
		entries: [{ id: "example", directory: "./plugin", entry: "." }],
		catalog: [],
	}
	const configuration = yield* Schema.encodeEffect(
		Schema.fromJsonString(Check.Configuration),
	)(config)
	yield* fs.writeFileString(root + "/check.json", configuration)
	return { root, text }
})
it.effect(
	"checks paths relative to the configuration without importing or changing packages",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const { root, text } = yield* setup()
			const result = yield* Check.inspect(root + "/check.json")
			assert.deepEqual(result, [])
			const after = yield* fs.readFileString(root + "/plugin/package.json")
			assert.equal(after, text)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
it.effect(
	"rejects a malformed published manifest before reporting compatibility",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const { root } = yield* setup()
			yield* fs.writeFileString(root + "/plugin/package.json", "{}")
			const result = yield* Effect.result(Check.inspect(root + "/check.json"))
			assert.equal(result._tag, "Failure")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
