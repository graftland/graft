import { Effect, FileSystem } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Artifact from "../src/Artifact"

const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.makeTempDirectoryScoped()
	const directory = root + "/source"
	const store = root + "/store"
	yield* fs.makeDirectory(directory)
	yield* fs.writeFileString(directory + "/package.json", '{"type":"module"}')
	yield* fs.writeFileString(
		directory + "/index.js",
		'export default "original"',
	)
	return {
		fs,
		root,
		directory,
		store,
		options: { directory, store, entry: "index.js" },
	}
})
const runtime = NodeServices.layer

it.live(
	"captures package bytes while excluding its nested artifact store and uncaptured dependencies (F2)",
	() =>
		Effect.gen(function* () {
			const { fs, directory, options } = yield* setup
			yield* fs.makeDirectory(directory + "/node_modules")
			yield* fs.symlink(
				directory + "/index.js",
				directory + "/node_modules/dependency",
			)
			const artifact = yield* Artifact.capture({
				...options,
				store: directory + "/.graft/artifacts",
				exclude: ["node_modules", ".graft"],
			})
			const dependencies = yield* fs.exists(
				artifact.directory + "/node_modules",
			)
			const store = yield* fs.exists(artifact.directory + "/.graft")
			assert.isFalse(dependencies)
			assert.isFalse(store)
			yield* Artifact.verify(artifact)
			const again = yield* Artifact.capture({
				...options,
				store: directory + "/.graft/artifacts",
				exclude: ["node_modules", ".graft"],
			})
			assert.deepEqual(again, artifact)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)
it.live(
	"captures deterministic versioned identities and isolates the original files",
	() =>
		Effect.gen(function* () {
			const { fs, directory, options } = yield* setup
			const first = yield* Artifact.capture(options)
			const second = yield* Artifact.capture(options)
			assert.deepEqual(first, second)
			assert.equal(first.identity.version, 1)
			assert.equal(first.identity.algorithm, "sha256")
			yield* fs.writeFileString(
				directory + "/index.js",
				'export default "changed"',
			)
			const observed1 = yield* fs.readFileString(first.directory + "/index.js")
			assert.include(observed1, "original")
			const observed2 = yield* Artifact.verify(first)
			assert.deepEqual(observed2, first.identity)
			const third = yield* Artifact.capture(options)
			assert.notEqual(first.identity.digest, third.identity.digest)
			yield* fs.writeFileString(first.directory + "/index.js", "tampered")
			const observed3 = yield* Effect.flip(Artifact.verify(first))
			assert.equal(observed3.detail, "Artifact digest mismatch")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"includes file names, package contents and the selected entry in the identity",
	() =>
		Effect.gen(function* () {
			const { fs, directory, options } = yield* setup
			yield* fs.writeFileString(
				directory + "/other.js",
				'export default "original"',
			)
			const first = yield* Artifact.capture(options)
			const other = yield* Artifact.capture({ ...options, entry: "other.js" })
			assert.notEqual(first.identity.digest, other.identity.digest)
			yield* fs.writeFileString(
				directory + "/package.json",
				'{"type":"module","version":"2"}',
			)
			const version = yield* Artifact.capture(options)
			assert.notEqual(first.identity.digest, version.identity.digest)
			yield* fs.rename(directory + "/other.js", directory + "/renamed.js")
			const renamed = yield* Artifact.capture(options)
			assert.notEqual(version.identity.digest, renamed.identity.digest)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"does no work until capture is executed and rejects unsupported layouts",
	() =>
		Effect.gen(function* () {
			const { fs, directory, store, options } = yield* setup
			const capture = Artifact.capture(options)
			const observed4 = yield* fs.exists(store)
			assert.isFalse(observed4)
			yield* capture
			for (const entry of [
				"../index.js",
				"/index.js",
				"index.ts",
				"nested/../index.js",
			]) {
				const observed5 = yield* Effect.flip(
					Artifact.capture({ ...options, entry }),
				)
				assert.equal(observed5._tag, "ArtifactError")
			}
			const observed6 = yield* Effect.flip(
				Artifact.capture({ ...options, store: directory + "/cache" }),
			)
			assert.equal(observed6._tag, "ArtifactError")
			yield* fs.remove(directory + "/package.json")
			const observed7 = yield* Effect.flip(Artifact.capture(options))
			assert.equal(observed7._tag, "ArtifactError")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"rejects escaping and internal symlinks rather than capturing mutable targets",
	() =>
		Effect.gen(function* () {
			const { fs, root, directory, options } = yield* setup
			yield* fs.writeFileString(root + "/external.js", "external")
			yield* fs.symlink(root + "/external.js", directory + "/linked.js")
			const observed8 = yield* Effect.flip(Artifact.capture(options))
			assert.include(observed8.detail, "symlinks")
			yield* fs.remove(directory + "/linked.js")
			yield* fs.symlink(directory + "/index.js", directory + "/linked.js")
			const observed9 = yield* Effect.flip(Artifact.capture(options))
			assert.include(observed9.detail, "symlinks")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("does not replace an existing corrupted capture", () =>
	Effect.gen(function* () {
		const { fs, options } = yield* setup
		const artifact = yield* Artifact.capture(options)
		yield* fs.writeFileString(artifact.directory + "/index.js", "corrupted")
		const observed10 = yield* Effect.flip(Artifact.capture(options))
		assert.equal(observed10.detail, "Artifact digest mismatch")
		const observed11 = yield* fs.readFileString(
			artifact.directory + "/index.js",
		)
		assert.equal(observed11, "corrupted")
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"deduplicates concurrent captures without partial published directories",
	() =>
		Effect.gen(function* () {
			const { options } = yield* setup
			const captures = yield* Effect.all(
				[Artifact.capture(options), Artifact.capture(options)],
				{ concurrency: 2 },
			)
			assert.deepEqual(captures[0], captures[1])
			yield* Artifact.verify(captures[0])
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"aborts capture when source bytes change during the copy and removes staging files",
	() =>
		Effect.gen(function* () {
			const { fs, directory, store, options } = yield* setup
			const failure = yield* Effect.flip(
				Artifact.capture(options).pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						copyFile: (from, to) =>
							fs
								.copyFile(from, to)
								.pipe(
									Effect.andThen(
										from === directory + "/index.js"
											? fs.writeFileString(from, "changed during copy")
											: Effect.void,
									),
								),
					}),
				),
			)
			assert.equal(failure.detail, "The source changed during artifact capture")
			const remaining = yield* fs.readDirectory(store)
			assert.deepEqual(remaining, [])
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("verifies overlap metadata without importing the implementation", () =>
	Effect.gen(function* () {
		const { fs, directory, options } = yield* setup
		yield* fs.writeFileString(
			directory + "/package.json",
			'{"name":"@example/verified-overlap","type":"module","graft":{"overlap":true}}',
		)
		yield* fs.writeFileString(
			directory + "/index.js",
			'throw new Error("Preparation must not import this module")',
		)
		const artifact = yield* Artifact.capture(options)
		const metadata = yield* Artifact.metadata(artifact)
		assert.deepStrictEqual(metadata, {
			package: "@example/verified-overlap",
			overlap: true,
		})
		yield* fs.writeFileString(
			artifact.directory + "/package.json",
			'{"graft":{"overlap":false}}',
		)
		const tampered = yield* Effect.flip(Artifact.metadata(artifact))
		assert.equal(tampered.detail, "Artifact digest mismatch")
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("defaults an absent overlap declaration to Restart", () =>
	Effect.gen(function* () {
		const { options } = yield* setup
		const artifact = yield* Artifact.capture(options)
		const metadata = yield* Artifact.metadata(artifact)
		assert.isFalse(metadata.overlap)
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)
