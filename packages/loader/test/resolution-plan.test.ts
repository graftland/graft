import { assert, it } from "@effect/vitest"
import { Plugin } from "@graftland/graft"
import {
	Array,
	Deferred,
	Effect,
	Fiber,
	Option,
	Path,
	Ref,
	Scope,
} from "effect"
import { ConfigDirectory, ModuleResolver } from "../src/index.ts"

const plugin = Plugin.make({ name: "planned", apply: () => Effect.void })

it.effect(
	"reuses resolution plans while acquiring fresh imports and observations",
	() =>
		Effect.gen(function* () {
			const revision = yield* Ref.make(0)
			const probes = yield* Ref.make<ReadonlyArray<string>>([])
			const imports = yield* Ref.make<ReadonlyArray<string>>([])
			const observations = yield* Ref.make(0)
			const releases = yield* Ref.make(0)
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				resolution: {
					revision: Ref.get(revision),
					exists: (name) =>
						Ref.update(probes, Array.append(name)).pipe(
							Effect.andThen(Ref.get(revision)),
							Effect.map(
								(revision) =>
									name === "@graftland/plugin-example" ||
									(revision > 0 && name === "example"),
							),
						),
					observe: (_names, { observationScope }) =>
						Ref.update(observations, (n) => n + 1).pipe(
							Effect.andThen(
								Scope.addFinalizer(
									observationScope,
									Ref.update(releases, (n) => n + 1),
								),
							),
						),
				},
				importer: (name) =>
					Ref.update(imports, Array.append(name)).pipe(
						Effect.as({ default: plugin }),
					),
			})
			yield* Effect.scoped(resolver.resolve("example"))
			yield* Effect.scoped(resolver.resolve("example"))
			assert.strictEqual((yield* Ref.get(probes)).length, 3)
			const checked1 = yield* Ref.get(imports)

			assert.deepStrictEqual(checked1, [
				"@graftland/plugin-example",
				"@graftland/plugin-example",
			])
			yield* Ref.set(revision, 1)
			yield* Effect.scoped(resolver.resolve("example"))
			assert.strictEqual((yield* Ref.get(probes)).length, 6)
			const checked2 = yield* Ref.get(imports)

			assert.deepStrictEqual(checked2, [
				"@graftland/plugin-example",
				"@graftland/plugin-example",
				"example",
			])
			const checked3 = yield* Ref.get(observations)

			assert.strictEqual(checked3, 3)
			const checked4 = yield* Ref.get(releases)

			assert.strictEqual(checked4, 3)
		}).pipe(Effect.provide(Path.layer)),
)

it.effect(
	"does not cache custom importer failures without a resolution environment",
	() =>
		Effect.gen(function* () {
			const installed = yield* Ref.make(false)
			const calls = yield* Ref.make<ReadonlyArray<string>>([])
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (name) =>
					Effect.gen(function* () {
						yield* Ref.update(calls, Array.append(name))
						if (name === "example" && !(yield* Ref.get(installed)))
							return yield* Effect.fail({
								code: "ERR_MODULE_NOT_FOUND",
								message:
									"Cannot find package 'example' imported from /app/index.js",
							})
						return { default: plugin }
					}),
			})
			yield* Effect.scoped(resolver.resolve("example"))
			yield* Ref.set(installed, true)
			yield* Effect.scoped(resolver.resolve("example"))
			const checked5 = yield* Ref.get(calls)

			assert.deepStrictEqual(checked5, [
				"example",
				"@graftland/plugin-example",
				"example",
			])
		}).pipe(Effect.provide(Path.layer)),
)

it.effect("does not let an old in-flight plan replace a newer revision", () =>
	Effect.gen(function* () {
		const revision = yield* Ref.make(0)
		const started = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		const probes = yield* Ref.make(0)
		const imports = yield* Ref.make<ReadonlyArray<string>>([])
		const resolver = yield* ModuleResolver.make({
			base: "/app",
			resolution: {
				revision: Ref.get(revision),
				observe: () => Effect.void,
				exists: (name) =>
					Effect.gen(function* () {
						yield* Ref.update(probes, (n) => n + 1)
						const version = yield* Ref.get(revision)
						if (name === "example" && version === 0) {
							yield* Deferred.succeed(started, undefined)
							yield* Deferred.await(release)
						}
						return name === "@graftland/plugin-example" || version > 0
					}),
			},
			importer: (name) =>
				Ref.update(imports, Array.append(name)).pipe(
					Effect.as({ default: plugin }),
				),
		})
		const old = yield* Effect.scoped(resolver.resolve("example")).pipe(
			Effect.forkScoped,
		)
		yield* Deferred.await(started)
		yield* Ref.set(revision, 1)
		yield* Effect.scoped(resolver.resolve("example"))
		yield* Deferred.succeed(release, undefined)
		yield* Fiber.join(old)
		const before = yield* Ref.get(probes)
		yield* Effect.scoped(resolver.resolve("example"))
		const checked6 = yield* Ref.get(probes)

		assert.strictEqual(checked6, before)
		const checked7 = yield* Ref.get(imports)

		assert.deepStrictEqual(checked7, [
			"example",
			"@graftland/plugin-example",
			"example",
		])
	}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect(
	"does not let a call that read an older revision reset the plan cache",
	() =>
		Effect.gen(function* () {
			const revision = yield* Ref.make(0)
			const stall = yield* Ref.make(true)
			const started = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const probes = yield* Ref.make(0)
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				resolution: {
					// The first call reads its revision, then stalls before consulting the cache.
					revision: Effect.gen(function* () {
						const current = yield* Ref.get(revision)
						if (yield* Ref.getAndSet(stall, false)) {
							yield* Deferred.succeed(started, undefined)
							yield* Deferred.await(release)
						}
						return current
					}),
					observe: () => Effect.void,
					exists: (name) =>
						Ref.update(probes, (n) => n + 1).pipe(
							Effect.as(name === "@graftland/plugin-example"),
						),
				},
				importer: () => Effect.succeed({ default: plugin }),
			})
			const old = yield* Effect.scoped(resolver.resolve("example")).pipe(
				Effect.forkScoped,
			)
			yield* Deferred.await(started)
			yield* Ref.set(revision, 1)
			yield* Effect.scoped(resolver.resolve("example"))
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(old)
			const before = yield* Ref.get(probes)
			yield* Effect.scoped(resolver.resolve("example"))
			const after = yield* Ref.get(probes)
			assert.strictEqual(after, before)
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

for (const preferred of ["present", "missing", "disappeared"] as const) {
	it.effect(
		`defers fallback resolution errors until needed: ${preferred}`,
		() =>
			Effect.gen(function* () {
				const failure = {
					code: "EACCES",
					message: "Fallback resolution denied",
				}
				const imports = yield* Ref.make<ReadonlyArray<string>>([])
				const resolver = yield* ModuleResolver.make({
					base: "/app",
					resolution: {
						revision: Effect.succeed(0),
						observe: () => Effect.void,
						exists: (name) =>
							name === "example"
								? Effect.succeed(preferred !== "missing")
								: Effect.fail(failure),
					},
					importer: (name) =>
						Ref.update(imports, Array.append(name)).pipe(
							Effect.andThen(
								preferred === "disappeared"
									? Effect.fail({
											code: "ERR_MODULE_NOT_FOUND",
											message:
												"Cannot find package 'example' imported from /app/index.js",
										})
									: Effect.succeed({ default: plugin }),
							),
						),
				})
				for (let i = 0; i < 2; i++) {
					const resolve = Effect.scoped(resolver.resolve("example"))
					if (preferred === "present") {
						const resolved = yield* resolve
						assert.strictEqual(resolved, plugin)
					} else {
						const error = yield* Effect.flip(resolve)
						assert(error._tag === "ModuleInvalid")
						assert.strictEqual(error.specifier, "@graftland/plugin-example")
						assert.strictEqual(error.cause, failure)
					}
				}
				const imported = yield* Ref.get(imports)
				assert.deepStrictEqual(
					imported,
					preferred === "missing" ? [] : ["example", "example"],
				)
			}).pipe(Effect.provide(Path.layer)),
	)
}

it.effect("does not cache a plan whose fallback probe failed", () =>
	Effect.gen(function* () {
		const denied = yield* Ref.make(true)
		const resolver = yield* ModuleResolver.make({
			base: "/app",
			resolution: {
				revision: Effect.succeed(0),
				observe: () => Effect.void,
				exists: (name) =>
					name === "example"
						? Effect.succeed(false)
						: Effect.flatMap(Ref.get(denied), (denied) =>
								denied
									? Effect.fail({ code: "EACCES", message: "Denied" })
									: Effect.succeed(true),
							),
			},
			importer: () => Effect.succeed({ default: plugin }),
		})
		const resolve = Effect.scoped(resolver.resolve("example"))
		const error = yield* Effect.flip(resolve)
		assert(error._tag === "ModuleInvalid")
		// The probe recovers without a revision change; the failure was not cached.
		yield* Ref.set(denied, false)
		const resolved = yield* resolve
		assert.strictEqual(resolved, plugin)
	}).pipe(Effect.provide(Path.layer)),
)

it.effect(
	"keeps relative resolution plans separate across configuration directories",
	() =>
		Effect.gen(function* () {
			const imports = yield* Ref.make<ReadonlyArray<string>>([])
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (specifier) =>
					Ref.update(imports, Array.append(specifier)).pipe(
						Effect.as({ default: plugin }),
					),
			})
			for (const directory of ["/app/first", "/app/second", "/app/first"]) {
				yield* resolver
					.resolve("./plugin.js")
					.pipe(Effect.provideService(ConfigDirectory, Option.some(directory)))
			}
			const imported = yield* Ref.get(imports)
			assert.deepStrictEqual(imported, [
				"file:///app/first/plugin.js",
				"file:///app/second/plugin.js",
				"file:///app/first/plugin.js",
			])
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)
