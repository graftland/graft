import { Context, Effect, FileSystem, Schema, String } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Manifest } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Contract from "../src/Contract"
import * as Publication from "../src/Publication"

class Value extends Context.Service<Value, {}>()(
	"@graftland/plugin-remote/test/publication.test/Value",
) {}
const source: Manifest.Source = {
	package: { name: "independent-contract", version: "1.0.0" },
	artifact: { version: 1, algorithm: "sha256", digest: String.repeat(64)("a") },
}
const contract = (success: Schema.Codec<unknown>) =>
	Contract.make({
		name: "independent-plugin",
		config: Schema.Struct({}),
		provides: [
			Contract.service(
				Value,
				RpcGroup.make(
					Contract.operation(
						"example/value",
						1,
						Rpc.make("Value", { success }),
					),
				),
				{
					toHandlers: () => ({ Value: () => Effect.undefined }),
					fromClient: () => ({}),
				},
			),
		],
	})
it("records package provenance without inspecting an opaque schema", () => {
	const described = Publication.declarations(
		contract(
			Schema.declare<symbol>(
				(value): value is symbol => typeof value === "symbol",
			),
		),
		source,
	)
	assert.deepEqual(described[0]?.operations, [
		{ identity: "example/value@1", ...source },
	])
})
it("does not compare schemas for one package at one digest", () => {
	const left = Publication.declarations(contract(Schema.String), source)
	const right = Publication.declarations(contract(Schema.Int), source)
	assert.deepEqual(left[0]?.operations, right[0]?.operations)
	assert.deepEqual(
		Manifest.conflicts([
			{ id: "first", operations: left[0]!.operations },
			{ id: "second", operations: right[0]!.operations },
		]),
		[],
	)
})
class Middleware extends RpcMiddleware.Service<Middleware>()(
	"@graftland/plugin-remote/test/publication.test/Middleware",
) {}
it("records streaming and middleware operations without imposing conformance kit limits", () => {
	const original = contract(Schema.String)
	const service = original.provides[0]!
	const group = RpcGroup.make(
		Contract.operation(
			"example/value",
			1,
			Rpc.make("Value", { success: Schema.String, stream: true }).middleware(
				Middleware,
			),
		),
	)
	const described = Publication.declarations(
		{ ...original, provides: [{ ...service, group }] },
		source,
	)
	assert.deepEqual(described[0]?.operations, [
		{ identity: "example/value@1", ...source },
	])
})
it.effect(
	"directory provenance follows package bytes, independently of the selected entry",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const root = yield* fs.makeTempDirectoryScoped()
			const directory = root + "/contract"
			yield* fs.makeDirectory(directory)
			yield* fs.writeFileString(
				directory + "/package.json",
				'{"name":"independent-contract","version":"1.0.0"}',
			)
			yield* fs.writeFileString(
				directory + "/first.js",
				"export default undefined",
			)
			yield* fs.writeFileString(
				directory + "/second.js",
				"export default undefined",
			)
			const before = yield* Artifact.directoryIdentity(directory)
			const first = yield* Artifact.capture({
				directory,
				entry: "first.js",
				store: root + "/store",
			})
			const second = yield* Artifact.capture({
				directory,
				entry: "second.js",
				store: root + "/store",
			})
			const firstDirectory = yield* Artifact.directoryIdentity(first.directory)
			const secondDirectory = yield* Artifact.directoryIdentity(
				second.directory,
			)
			assert.deepEqual(firstDirectory, before)
			assert.deepEqual(secondDirectory, before)
			assert.notEqual(first.identity.digest, second.identity.digest)
			yield* fs.writeFileString(directory + "/first.js", "export default null")
			const after = yield* Artifact.directoryIdentity(directory)
			assert.notEqual(after.digest, before.digest)
			const declarations = (artifact: Manifest.DirectoryIdentity) =>
				Publication.declarations(contract(Schema.String), {
					...source,
					artifact,
				})[0]!.operations
			const conflicts = Manifest.conflicts([
				{ id: "installed", operations: declarations(before) },
				{ id: "changed", operations: declarations(after) },
			])
			assert.equal(conflicts[0]?.code, "ProvenanceConflict")
			assert.include(conflicts[0]!.message, before.digest)
			assert.include(conflicts[0]!.message, after.digest)
			yield* fs.symlink(directory + "/first.js", directory + "/linked.js")
			const invalid = yield* Effect.flip(Artifact.directoryIdentity(directory))
			assert.include(invalid.detail, "symlinks")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
it("canonicalizes JSON objects while preserving meaningful array order", () => {
	assert.deepEqual(Publication.canonical({ z: { b: 2, a: 1 }, a: [2, 1] }), {
		a: [2, 1],
		z: { a: 1, b: 2 },
	})
})
it.effect(
	"records the same directory identity as capture and notices changed package bytes",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const root = yield* fs.makeTempDirectoryScoped()
			const source = root + "/source"
			yield* fs.makeDirectory(source)
			const manifest: Manifest.Package = {
				name: "published",
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
			const text = yield* Schema.encodeEffect(
				Schema.fromJsonString(Manifest.Package),
			)(manifest)
			yield* fs.writeFileString(source + "/package.json", text)
			yield* fs.writeFileString(
				source + "/index.js",
				"export default undefined",
			)
			const artifact = yield* Artifact.capture({
				directory: source,
				entry: "index.js",
				store: root + "/store",
			})
			for (const name of ["constructor", "toString", "__proto__"]) {
				const missing = yield* Effect.flip(Publication.provenance(source, name))
				assert.include(missing.message, `No manifest entry ${name}`)
			}
			const record = yield* Publication.provenance(artifact.directory, ".")
			assert.deepEqual(record.artifact, artifact.identity)
			assert.deepEqual(record.package, { name: "published", version: "1.0.0" })
			yield* fs.writeFileString(source + "/index.js", "export default null")
			const changed = yield* Publication.provenance(source, ".")
			assert.notEqual(changed.artifact.digest, record.artifact.digest)
			yield* fs.symlink(source, root + "/alias")
			const invalidOutput = yield* Effect.flip(
				Publication.record(source, root + "/alias/provenance.json"),
			)
			assert.include(invalidOutput.message, "outside the package directory")
			const recordedInside = yield* fs.exists(source + "/provenance.json")
			assert.isFalse(recordedInside)
			const records = yield* Publication.record(
				source,
				root + "/provenance.json",
			)
			assert.equal(records[0]?.artifact.digest, changed.artifact.digest)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
