import { Array, Effect, FileSystem, Path, Predicate, Ref } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Plugin } from "@graftland/graft"

import { ModuleResolver } from "../src/index.ts"

/** A native module bypasses Vitest's rewritten module-resolution errors. */
const nativeModule: string =
	"data:text/javascript,export const load = specifier => import(specifier)"
const nativeImporter = (specifier: string): Promise<unknown> =>
	import(/* @vite-ignore */ nativeModule).then((module) =>
		module.load(specifier),
	)

it.effect.each([
	"relative path",
	"absolute path",
	"file URL",
	"file URL with suffix",
])("classifies a missing candidate addressed by %s", (kind) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* fs.makeTempDirectoryScoped()
		const file = path.join(directory, "missing space #%.mjs")
		const url = yield* path.toFileUrl(file)
		const specifier =
			kind === "relative path"
				? "./missing space #%.mjs"
				: kind === "absolute path"
					? file
					: url.href +
						(kind === "file URL with suffix" ? "?version=1#entry" : "")
		const resolver = yield* ModuleResolver.make({
			base: directory,
			importer: nativeImporter,
		})
		const error = yield* Effect.flip(resolver.resolve(specifier))
		assert.strictEqual(error._tag, "ModuleNotFound")
		assert(error._tag === "ModuleNotFound")
		assert.deepStrictEqual(error.tried, [specifier])
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect.each(["relative path", "file URL", "file URL with suffix"])(
	"retains a missing dependency as ModuleInvalid for a %s",
	(kind) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = path.join(directory, "entry.mjs")
			yield* fs.writeFileString(
				file,
				'import "./missing-dependency.mjs"; export default {}',
			)
			const url = yield* path.toFileUrl(file)
			const specifier =
				kind === "relative path"
					? "./entry.mjs"
					: url.href +
						(kind === "file URL with suffix" ? "?version=1#entry" : "")
			const resolver = yield* ModuleResolver.make({
				base: directory,
				importer: nativeImporter,
			})
			const error = yield* Effect.flip(resolver.resolve(specifier))
			assert(error._tag === "ModuleInvalid")
			assert.strictEqual(error.specifier, specifier)
			const causes = (value: unknown): ReadonlyArray<unknown> =>
				Predicate.hasProperty(value, "cause")
					? [value, ...causes(value.cause)]
					: [value]
			assert.isTrue(
				Array.some(
					causes(error.cause),
					(cause) =>
						Predicate.hasProperty(cause, "code") &&
						cause.code === "ERR_MODULE_NOT_FOUND",
				),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect.each(["file://[", "file:///invalid%2Fpath.mjs"])(
	"rejects an invalid file URL before invoking the importer: %s",
	(specifier) =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0)
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: () => Ref.update(calls, (n) => n + 1),
			})
			const error = yield* Effect.flip(resolver.resolve(specifier))
			assert(error._tag === "ModuleInvalid")
			assert.strictEqual(error.specifier, specifier)
			const count = yield* Ref.get(calls)
			assert.strictEqual(count, 0)
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect(
	"preserves a file URL's encoded path, query and fragment for the importer",
	() =>
		Effect.gen(function* () {
			const specifier = "file:///plugins/space%20%23%25.mjs?version=2#entry"
			const calls = yield* Ref.make<ReadonlyArray<string>>([])
			const plugin = Plugin.make({ name: "loaded", apply: () => Effect.void })
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (name) =>
					Ref.update(calls, Array.append(name)).pipe(
						Effect.as({ default: plugin }),
					),
			})
			const loaded = yield* resolver.resolve(specifier)
			assert.strictEqual(loaded, plugin)
			const imported = yield* Ref.get(calls)
			assert.deepStrictEqual(imported, [specifier])
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)
