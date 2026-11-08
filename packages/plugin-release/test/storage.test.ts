import { ConfigProvider, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import { Artifact } from "@graftland/plugin-remote"

import {
	build,
	load,
	references,
	resolveInput,
	write,
} from "../src/internal/storage"
import type { Release } from "../src/Model"

const runtime = Graft.layer.pipe(Layer.provideMerge(NodeServices.layer))
const release: Release = {
	version: 1,
	entries: [],
	references: [],
	revocations: [],
}
const setup = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const store = yield* fs.makeTempDirectoryScoped()
	const stage = path.join(store, "stage")
	yield* fs.makeDirectory(stage)
	yield* write(path.join(stage, "package.json"), {
		name: "test-release",
		version: "1.0.0",
	})
	yield* write(path.join(stage, "release.json"), release)
	const id = (yield* Artifact.directoryIdentity(stage)).digest
	yield* fs.rename(stage, path.join(store, id))

	return { fs, path, store, id }
})

it.effect(
	"keeps environment values out of encoded configuration and reference inventories",
	() =>
		Effect.gen(function* () {
			const encoded = {
				credential: { $env: "TOKEN" },
				nested: [{ $env: "OTHER" }],
			}
			assert.deepEqual(references(encoded), ["env:TOKEN", "env:OTHER"])
			const resolved = yield* resolveInput(encoded)
			assert.deepEqual(resolved, { credential: "secret", nested: ["second"] })
			assert.deepEqual(encoded.credential, { $env: "TOKEN" })
			const error = yield* Effect.flip(
				resolveInput({ $env: "TOKEN", fallback: "forbidden" }),
			)
			assert.equal(error.code, "Reference")
		}).pipe(
			Effect.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({ TOKEN: "secret", OTHER: "second" }),
				),
			),
		),
)

it.effect(
	"verifies all immutable release bytes and rejects path traversal",
	() =>
		Effect.gen(function* () {
			const { fs, path, store, id } = yield* setup()
			const loaded = yield* load(store, id)
			assert.deepEqual(loaded, release)
			yield* fs.writeFileString(path.join(store, id, "extra"), "changed")
			assert.equal((yield* Effect.flip(load(store, id))).code, "Integrity")
			assert.equal(
				(yield* Effect.flip(load(store, "../journal.json"))).code,
				"Storage",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect("rejects unmanaged release sources before creating a release", () =>
	Effect.gen(function* () {
		const { fs, path, store } = yield* setup()
		const file = path.join(store, "source.yml")
		yield* fs.writeFileString(file, "- id: host\n  name: ordinary-plugin\n")
		assert.equal(
			(yield* Effect.flip(
				build(path.join(store, "output"), {
					file,
					references: [],
					revocations: [],
				}),
			)).code,
			"Configuration",
		)
		const exists = yield* fs.exists(path.join(store, "output"))
		assert.equal(exists, false)
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"reuses a metadata-only release without importing package code on either build",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			const directory = h.path.join(h.store, "untrusted")
			yield* h.fs.makeDirectory(directory)
			const marker = h.path.join(h.store, "imported.txt")
			const secret = h.path.join(h.store, "host-secret.txt")
			yield* h.fs.writeFileString(secret, "Host-only data")
			yield* h.fs.writeFileString(
				h.path.join(directory, "index.js"),
				`import { copyFileSync } from "node:fs"; copyFileSync(${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(secret)}, ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(marker)}); throw new Error("Untrusted import executed")`,
			)
			yield* h.fs.writeFileString(
				h.path.join(h.store, "contract.js"),
				"export default null",
			)
			yield* write(h.path.join(directory, "package.json"), {
				name: "@example/untrusted",
				version: "1.0.0",
				type: "module",
				engines: { node: ">=22.19.0" },
				peerDependencies: { effect: "4.1.*", "@graftland/graft": "0.0.0" },
				graft: {
					version: 1,
					entries: {
						".": {
							implementation: "index.js",
							contracts: [],
							probes: [],
							requirements: {
								placements: ["Local"],
								filesystem: false,
								nativeModules: false,
							},
							services: { required: [], optional: [], implements: [] },
							operations: [],
						},
					},
				},
			})
			const source = h.path.join(h.store, "untrusted.yml")
			yield* write(source, [
				{
					id: "untrusted",
					name: "@graftland/plugin-remote",
					config: {
						package: "./untrusted",
						entry: ".",
						contract: "./contract.js",
						target: { _tag: "Local" },
						config: {},
						probes: [],
					},
				},
			])
			const id = yield* build(h.store, {
				file: source,
				references: [],
				revocations: [],
				metadataOnly: true,
			})
			const firstImport = yield* h.fs.exists(marker)
			assert.isFalse(firstImport)
			const repeated = yield* build(h.store, {
				file: source,
				references: [],
				revocations: [],
				metadataOnly: true,
			})
			assert.equal(repeated, id)
			const secondImport = yield* h.fs.exists(marker)
			assert.isFalse(secondImport)
			const result = yield* load(h.store, id, true)
			assert.equal(result.entries[0]?.package.name, "@example/untrusted")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)
