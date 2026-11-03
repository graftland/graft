import { createRequire } from "node:module"
import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { Graft as GraftType, Plugin as PluginType } from "@graftland/graft"
import {
	Deferred,
	Cause,
	Exit,
	Effect,
	Fiber,
	FileSystem,
	Logger,
	Queue,
	Path,
	Option,
	Schema,
	Predicate,
	Scope,
	Stream,
	String,
} from "effect"

const runtimeUrl = new URL("../.cache/integration/runtime.mjs", import.meta.url)
const { Hmr, Graft } = createRequire(import.meta.url)(
	runtimeUrl.pathname,
) as typeof import("./runtime.ts")

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		GraftType.Graft | FileSystem.FileSystem | Path.Path | Scope.Scope
	>,
) =>
	effect.pipe(
		Effect.provide(Graft.layer),
		Effect.provide([NodeFileSystem.layer, Path.layer]),
		Effect.scoped,
	)

const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

class ImportRejected extends Schema.TaggedError<
	ImportRejected,
	{ readonly brand: unique symbol }
>()("ImportRejected", { cause: Schema.Unknown }) {}

const setup = (owner?: Scope.Scope) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs
			.makeTempDirectoryScoped()
			.pipe(Effect.flatMap(fs.realPath))
		const path = yield* Path.Path
		const base = (yield* path.toFileUrl(`${directory}/app.mjs`)).href
		const make = Hmr.make({
			base,
			include: String.startsWith(new URL(".", base).href),
		})
		const hmr = yield* owner === undefined
			? make
			: Effect.provideService(make, Scope.Scope, owner)
		const runtimeSource = yield* quote(runtimeUrl.href)
		const effectSource = yield* quote(import.meta.resolve("effect"))
		const source = (name: string) => `
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
export default Plugin.make({ name: '${name}', apply: () => Effect.void });
`
		const write = (name: string, text: string) =>
			fs.writeFileString(`${directory}/${name}`, text)
		const load = (name: string) =>
			Effect.promise(() => hmr.importer(name)).pipe(
				Effect.map((namespace) => {
					assert(Predicate.hasProperty(namespace, "default"))
					return namespace.default as PluginType.Plugin<void, void, never>
				}),
			)
		return { hmr, source, write, load, directory }
	})

describe("HMR session lifecycle", () => {
	it.live.each(["scoped", "promise"])(
		"observes a failing %s import during shutdown",
		(mode) =>
			Effect.gen(function* () {
				const logs = yield* Queue.unbounded<Cause.Cause<unknown>>()
				const logger = Logger.layer([
					Logger.make((entry) => {
						Queue.offerUnsafe(logs, entry.cause)
					}),
				])
				yield* Effect.gen(function* () {
					const owner = yield* Scope.make()
					yield* Effect.addFinalizer((exit) => Scope.close(owner, exit))
					const { hmr, source, write, directory } = yield* setup(owner)
					const entered = yield* Deferred.make<void>()
					const closing = yield* Deferred.make<void>()
					const release = Promise.withResolvers<void>()
					const key = `graft-import-cancel:${directory}`
					const keySource = yield* quote(key)
					yield* Effect.acquireRelease(
						Effect.sync(() => {
							Reflect.set(globalThis, key, {
								enter: () => Deferred.doneUnsafe(entered, Exit.void),
								release: release.promise,
							})
						}),
						() =>
							Effect.sync(() => {
								release.resolve()
								Reflect.deleteProperty(globalThis, key)
							}),
					)
					yield* Scope.addFinalizer(owner, Deferred.succeed(closing, undefined))
					yield* write(
						"plugin.mjs",
						`globalThis[${keySource}].enter();
await globalThis[${keySource}].release;
throw new Error('LATE_IMPORT_FAILURE');
${source("pending")}`,
					)
					yield* Effect.gen(function* () {
						const importing = yield* (
							mode === "scoped"
								? hmr
										.importerScoped("./plugin.mjs")
										.pipe(
											Effect.mapError((cause) =>
												ImportRejected.make({ cause }),
											),
										)
								: Effect.tryPromise({
										try: () => hmr.importer("./plugin.mjs"),
										catch: (cause) => ImportRejected.make({ cause }),
									})
						).pipe(Effect.exit, Effect.forkChild)
						yield* Deferred.await(entered)
						const stopping = yield* (
							mode === "scoped"
								? Fiber.interrupt(importing)
								: Scope.close(owner, Exit.void)
						).pipe(Effect.forkChild({ startImmediately: true }))
						if (mode === "promise") yield* Deferred.await(closing)
						release.resolve()
						yield* Fiber.join(stopping)
						const finished = yield* Fiber.await(importing)
						assert(Exit.isFailure(finished) || Exit.isFailure(finished.value))
						const count = yield* Queue.size(logs)
						assert.strictEqual(count, 1)
						const cause = yield* Queue.take(logs)
						assert.include(Cause.pretty(cause), "LATE_IMPORT_FAILURE")
					}).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
				}).pipe(Effect.provide(logger))
			}).pipe(run),
	)

	it.live.each([false, true])(
		"releases the last entry lease without blocking another module (CommonJS: %s)",
		(commonjs) =>
			Effect.gen(function* () {
				const { hmr, source, write, directory } = yield* setup()
				const a = yield* Scope.make()
				const duplicate = yield* Scope.make()
				yield* Effect.addFinalizer((exit) => Scope.close(a, exit))
				yield* Effect.addFinalizer((exit) => Scope.close(duplicate, exit))
				yield* write("legacy.cjs", "module.exports = 1")
				yield* write(
					"a.mjs",
					(commonjs ? "import './legacy.cjs';\n" : "") + source("a"),
				)
				yield* write("b.mjs", source("b1"))
				yield* hmr
					.importerScoped("./a.mjs")
					.pipe(Effect.provideService(Scope.Scope, a))
				yield* hmr
					.importerScoped("./a.mjs")
					.pipe(Effect.provideService(Scope.Scope, duplicate))
				yield* hmr.importerScoped("./b.mjs")
				yield* Scope.close(a, Exit.void)
				if (!commonjs) {
					yield* write("a.mjs", "export default ???")
					const blocked = yield* Effect.exit(hmr.reload)
					assert(Exit.isFailure(blocked))
				}
				yield* Scope.close(duplicate, Exit.void)
				yield* write("a.mjs", "export default ???")
				yield* write("b.mjs", source("b2"))
				const result = yield* hmr.reload
				assert.deepStrictEqual(result, {
					_tag: "Reloaded",
					entries: [new URL(`file://${directory}/b.mjs`).href],
				})
			}).pipe(run),
	)

	it.live("reports a closed session when importing after scope shutdown", () =>
		Effect.gen(function* () {
			const hmr = yield* Effect.scoped(Hmr.make({ base: import.meta.url }))
			const error = yield* Effect.flip(
				Effect.tryPromise({
					try: () => hmr.importer("./missing.mjs"),
					catch: (cause) => ImportRejected.make({ cause }),
				}).pipe(Effect.asVoid),
			)
			assert(Predicate.hasProperty(error.cause, "stage"))
			assert.strictEqual(error.cause.stage, "closed")
		}).pipe(run),
	)

	it.live("serializes a pending native import with a reload", () =>
		Effect.gen(function* () {
			const { hmr, source, write, load, directory } = yield* setup()
			const entered = yield* Deferred.make<void>()
			const release = Promise.withResolvers<void>()
			const key = `graft-hmr-test:${directory}`
			const keySource = yield* quote(key)
			// The native module runner cannot import the test's Vite module graph.
			// This bridge lets its top-level await be controlled without a timer.
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					Reflect.set(globalThis, key, {
						enter: () => Deferred.doneUnsafe(entered, Effect.void),
						release: release.promise,
					})
				}),
				() =>
					Effect.sync(() => {
						release.resolve()
						Reflect.deleteProperty(globalThis, key)
					}),
			)
			yield* write(
				"plugin.mjs",
				`
const gate = globalThis[${keySource}];
gate.enter();
await gate.release;
${source("first")}
`,
			)
			yield* Effect.gen(function* () {
				const importing = yield* load("./plugin.mjs").pipe(Effect.forkChild)
				yield* Deferred.await(entered)
				const reloading = yield* hmr.reload.pipe(
					Effect.forkChild({ startImmediately: true }),
				)
				yield* write("plugin.mjs", source("second"))
				release.resolve()
				const original = yield* Fiber.join(importing)
				assert.strictEqual(original.name, "first")
				const reloaded = yield* Fiber.join(reloading)
				assert.strictEqual(reloaded._tag, "Reloaded")
				const current = yield* load("./plugin.mjs")
				assert.strictEqual(current.name, "second")
				const fork = yield* Graft.plugin(original)
				yield* fork.await
				const trees = yield* Graft.forks.pipe(Stream.runHead)
				assert.strictEqual(Option.getOrThrow(trees)[0]?.name, "second")
			}).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
		}).pipe(run),
	)
	it.live(
		"keeps hooks installed until a pending native import settles during shutdown",
		() =>
			Effect.gen(function* () {
				const owner = yield* Scope.make()
				yield* Effect.addFinalizer((exit) => Scope.close(owner, exit))
				const { hmr, source, write, directory } = yield* setup(owner)
				const entered = yield* Deferred.make<void>()
				const closing = yield* Deferred.make<void>()
				const imported = yield* Deferred.make<string>()
				const release = Promise.withResolvers<void>()
				const key = `graft-hmr-shutdown:${directory}`
				const keySource = yield* quote(key)
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						Reflect.set(globalThis, key, {
							enter: () => Deferred.doneUnsafe(entered, Exit.void),
							loaded: (url: string) =>
								Deferred.doneUnsafe(imported, Exit.succeed(url)),
							release: release.promise,
						})
					}),
					() =>
						Effect.sync(() => {
							release.resolve()
							Reflect.deleteProperty(globalThis, key)
						}),
				)
				yield* Scope.addFinalizer(owner, Deferred.succeed(closing, undefined))
				yield* write(
					"late.mjs",
					`globalThis[${keySource}].loaded(import.meta.url);`,
				)
				yield* write(
					"plugin.mjs",
					`
const gate = globalThis[${keySource}];
gate.enter();
await gate.release;
await import('./late.mjs');
${source("pending")}
`,
				)
				yield* Effect.gen(function* () {
					const importing = yield* Effect.tryPromise({
						try: () => hmr.importer("./plugin.mjs"),
						catch: (cause) => ImportRejected.make({ cause }),
					}).pipe(Effect.exit, Effect.forkChild)
					yield* Deferred.await(entered)
					const shutdown = yield* Scope.close(owner, Exit.void).pipe(
						Effect.forkChild,
					)
					yield* Deferred.await(closing)
					release.resolve()
					const url = yield* Deferred.await(imported)
					assert.include(url, "graft-hmr-")
					yield* Fiber.join(shutdown)
					const result = yield* Fiber.join(importing)
					assert(Exit.isFailure(result))
					const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
					assert(Predicate.hasProperty(error.cause, "message"))
					assert.strictEqual(
						error.cause.message,
						"All fibers interrupted without error",
					)
					const reloaded = yield* Effect.exit(hmr.reload)
					assert(Exit.isFailure(reloaded))
					assert.strictEqual(
						Option.getOrThrow(Cause.findErrorOption(reloaded.cause)).stage,
						"closed",
					)
				}).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
			}).pipe(run),
	)
})
