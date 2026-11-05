import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Ref, Schema } from "effect"
import * as Packages from "../src/internal/runner/Packages"
import { PackageError } from "../src/internal/runner/model"

const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.makeTempDirectoryScoped()
	const directory = root + "/node_modules/remote-fixture"
	yield* fs.makeDirectory(directory, { recursive: true })
	const manifest = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.Json),
	)({
		name: "remote-fixture",
		version: "1.2.3",
		type: "module",
		exports: {
			".": { import: "./contract.js", require: "./wrong.cjs" },
			"./contract": "./contract.js",
		},
	})
	yield* fs.writeFileString(directory + "/package.json", manifest)
	// Resolving a contract must never evaluate it in the supervisor.
	yield* fs.writeFileString(
		directory + "/contract.js",
		'throw new Error("Do not import in the supervisor")',
	)
	yield* fs.writeFileString(
		directory + "/wrong.cjs",
		'throw new Error("Incorrect resolution conditions")',
	)
	return { fs, root, directory }
})

describe("runner installed packages", () => {
	it.effect("only traverses package contents when a digest is requested", () =>
		Effect.gen(function* () {
			const { fs, root } = yield* setup
			const reads = yield* Ref.make(0)
			const observed = {
				...fs,
				readDirectory: (path: string) =>
					Ref.update(reads, (n) => n + 1).pipe(
						Effect.andThen(fs.readDirectory(path)),
					),
			}
			const ordinary = yield* Packages.resolve(root, "remote-fixture").pipe(
				Effect.provideService(FileSystem.FileSystem, observed),
			)
			assert.isUndefined(ordinary.identity.digest)
			const before = yield* Ref.get(reads)
			assert.equal(before, 0)
			const pinned = yield* Packages.resolve(root, "remote-fixture", true).pipe(
				Effect.provideService(FileSystem.FileSystem, observed),
			)
			assert.match(pinned.identity.digest ?? "", /^[a-f0-9]{64}$/)
			const after = yield* Ref.get(reads)
			assert.isAbove(after, 0)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.effect(
		"resolves import exports in the runner installation without executing the contract",
		() =>
			Effect.gen(function* () {
				const { fs, root, directory } = yield* setup
				const resolved = yield* Packages.resolve(root, "remote-fixture", true)
				const entry = yield* fs.realPath(directory + "/contract.js")
				assert.equal(resolved.entry, entry)
				assert.equal(resolved.identity.name, "remote-fixture")
				assert.equal(resolved.identity.version, "1.2.3")
				assert.match(resolved.identity.digest ?? "", /^[a-f0-9]{64}$/)
				const subpath = yield* Packages.resolve(
					root,
					"remote-fixture/contract",
					true,
				)
				assert.deepEqual(subpath, resolved)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
	it.effect(
		"hashes paths and content deterministically while excluding node_modules",
		() =>
			Effect.gen(function* () {
				const { fs, directory } = yield* setup
				const original = yield* Packages.digest(directory)
				yield* fs.makeDirectory(directory + "/node_modules/dependency", {
					recursive: true,
				})
				yield* fs.writeFileString(
					directory + "/node_modules/dependency/index.js",
					"dependency",
				)
				const unchanged = yield* Packages.digest(directory)
				assert.equal(unchanged, original)
				yield* fs.writeFileString(directory + "/contract.js", "changed")
				const changed = yield* Packages.digest(directory)
				assert.notEqual(changed, original)
				yield* fs.rename(directory + "/contract.js", directory + "/renamed.js")
				const renamed = yield* Packages.digest(directory)
				assert.notEqual(renamed, changed)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.effect("follows links in the trusted installation", () =>
		Effect.gen(function* () {
			const { fs, root, directory } = yield* setup
			const installed = root + "/package-store"
			yield* fs.rename(directory, installed)
			yield* fs.symlink(installed, directory)
			yield* fs.writeFileString(root + "/shared.js", "shared")
			yield* fs.symlink(root + "/shared.js", installed + "/linked.js")
			const resolved = yield* Packages.resolve(root, "remote-fixture", true)
			const real = yield* fs.realPath(installed)
			const digest = yield* Packages.digest(installed)
			assert.equal(resolved.directory, real)
			assert.equal(resolved.identity.digest, digest)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.effect(
		"rejects version and digest pins without importing plugin code",
		() =>
			Effect.gen(function* () {
				const { root } = yield* setup
				for (const expected of [
					{ version: "9.0.0" },
					{ digest: "incorrect" },
				]) {
					const error = yield* Effect.flip(
						Packages.resolve(
							root,
							"remote-fixture",
							expected.digest !== undefined,
						).pipe(
							Effect.flatMap((resolved) =>
								Packages.verify(resolved.identity, expected),
							),
						),
					)
					assert.isTrue(Schema.is(PackageError)(error))
					if (Schema.is(PackageError)(error))
						assert.include(error.detail, "mismatch")
				}
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30_000,
	)
})
