// Native require bypasses Vite so integration tests exercise Node's module hooks.
import { createRequire } from "node:module"
import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Option,
	Path,
	Predicate,
	Schema,
	Stream,
	String as Str,
} from "effect"
import type { Graft as GraftType, Plugin as PluginType } from "@nmnmcc/graft"

const runtimeUrl = new URL("../.cache/integration/runtime.mjs", import.meta.url)
const { Hmr, Graft } = createRequire(import.meta.url)(
	runtimeUrl.pathname,
) as typeof import("./runtime.ts")
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const effectUrl = import.meta.resolve("effect")

const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const temporary = yield* fs.makeTempDirectoryScoped()
	const directory = yield* fs.realPath(temporary)
	const runtimeSource = yield* quote(runtimeUrl.href)
	const effectSource = yield* quote(effectUrl)
	const runtimePath = yield* quote(runtimeUrl.pathname)
	const effectPath = yield* quote(new URL(effectUrl).pathname)
	const base = (yield* path.toFileUrl(`${directory}/app.mjs`)).href
	const root = new URL(".", base).href
	const hmr = yield* Hmr.make({ base, include: Str.startsWith(root) })
	const write = (name: string, source: string) =>
		fs.writeFileString(`${directory}/${name}`, source)
	const entry = (name: string) => `
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
import { value } from './dependency.mjs';
export default Plugin.make({ name: '${name}-' + value, apply: () => Effect.void });
`
	const load = Effect.fnUntraced(function* (name: string) {
		const namespace = yield* Effect.promise(() => hmr.importer(name))
		assert(Predicate.hasProperty(namespace, "default"))
		return namespace.default as PluginType.Plugin<void, void, never>
	})
	const names = Graft.forks.pipe(
		Stream.map((forks) => Arr.map(forks, (fork) => fork.name)),
	)
	const reach = (expected: ReadonlyArray<string>) =>
		names.pipe(
			Stream.filter(
				(names) =>
					names.length === expected.length &&
					Arr.every(names, (name, index) => name === expected[index]),
			),
			Stream.runHead,
			Effect.timeout("5 seconds"),
		)
	return {
		fs,
		directory,
		base,
		hmr,
		write,
		entry,
		load,
		reach,
		runtimePath,
		effectPath,
	}
})

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| GraftType.Graft
		| import("effect").Scope.Scope
		| FileSystem.FileSystem
		| Path.Path
	>,
) =>
	effect.pipe(
		Effect.provide(Graft.layer),
		Effect.provide([NodeFileSystem.layer, Path.layer]),
		Effect.scoped,
	)

describe("native HMR", () => {
	it.live("reloads dependencies across every entry and retains aliases", () =>
		Effect.gen(function* () {
			const { write, entry, load, hmr, reach } = yield* setup
			yield* write("dependency.mjs", "export const value = 1")
			yield* write("a.mjs", entry("a"))
			yield* write("b.mjs", entry("b"))
			const a = yield* load("./a.mjs")
			const b = yield* load("./b.mjs")
			const repeated = yield* load("./a.mjs")
			assert.strictEqual(repeated, a)
			yield* Graft.plugin(a)
			yield* Graft.plugin(b)
			yield* reach(["a-1", "b-1"])
			yield* write("dependency.mjs", "export const value = 2")
			assert.strictEqual((yield* hmr.reload)._tag, "Reloaded")
			yield* reach(["a-2", "b-2"])
			yield* write("dependency.mjs", "export const value = 3")
			const results = yield* Effect.all([hmr.reload, hmr.reload], {
				concurrency: 2,
			})
			assert(Arr.every(results, (result) => result._tag === "Reloaded"))
			yield* reach(["a-3", "b-3"])
			yield* Graft.plugin(a)
			yield* reach(["a-3", "b-3", "a-3"])
		}).pipe(run),
	)

	it.live("retries a failed first import after reloading without entries", () =>
		Effect.gen(function* () {
			const { write, entry, load, hmr, reach } = yield* setup
			yield* write(
				"dependency.mjs",
				"export const value = 1; throw new Error('initial evaluation failed')",
			)
			yield* write("a.mjs", entry("a"))
			const failed = yield* Effect.exit(load("./a.mjs"))
			assert(Exit.isFailure(failed))
			yield* write("dependency.mjs", "export const value = 2")
			const cached = yield* Effect.exit(load("./a.mjs"))
			assert(Exit.isFailure(cached))
			const reloaded = yield* hmr.reload
			assert.deepStrictEqual(reloaded, { _tag: "Reloaded", entries: [] })
			const plugin = yield* load("./a.mjs")
			yield* Graft.plugin(plugin)
			yield* reach(["a-2"])
		}).pipe(run),
	)

	it.live("forgets deleted entries so remaining plugins can reload", () =>
		Effect.gen(function* () {
			const { fs, directory, base, write, entry, load, hmr, reach } =
				yield* setup
			yield* write("dependency.mjs", "export const value = 1")
			yield* write("a.mjs", entry("a"))
			yield* write("b.mjs", entry("b"))
			const pluginA = yield* load("./a.mjs")
			const pluginB = yield* load("./b.mjs")
			const a = yield* Graft.plugin(pluginA)
			yield* Graft.plugin(pluginB)
			yield* reach(["a-1", "b-1"])
			yield* a.dispose
			yield* fs.remove(`${directory}/a.mjs`)
			yield* write("dependency.mjs", "export const value = 2")
			const reloaded = yield* hmr.reload
			assert.deepStrictEqual(reloaded, {
				_tag: "Reloaded",
				entries: [new URL("./b.mjs", base).href],
			})
			yield* reach(["b-2"])
			yield* write(
				"a.mjs",
				"throw new Error('forgotten entry must not be imported')",
			)
			yield* write("dependency.mjs", "export const value = 3")
			assert.strictEqual((yield* hmr.reload)._tag, "Reloaded")
			yield* reach(["b-3"])
		}).pipe(run),
	)

	it.live("discards all candidates on import failure and can recover", () =>
		Effect.gen(function* () {
			const { write, entry, load, hmr, reach } = yield* setup
			yield* write("dependency.mjs", "export const value = 1")
			yield* write("a.mjs", entry("a"))
			yield* write("b.mjs", entry("b"))
			const pluginA = yield* load("./a.mjs")
			const a = yield* Graft.plugin(pluginA)
			const pluginB = yield* load("./b.mjs")
			const b = yield* Graft.plugin(pluginB)
			yield* a.await
			yield* b.await
			yield* write("dependency.mjs", "export const value = 2")
			yield* write("b.mjs", "throw new Error('candidate failed')")
			const failed = yield* Effect.exit(hmr.reload)
			assert(Exit.isFailure(failed))
			const error = Option.getOrThrow(Cause.findErrorOption(failed.cause))
			assert.strictEqual(error.stage, "import")
			assert(Predicate.hasProperty(error.cause, "message"))
			assert.strictEqual(error.cause.message, "candidate failed")
			yield* reach(["a-1", "b-1"])
			yield* a.await
			yield* b.await
			yield* write("b.mjs", entry("b"))
			assert.strictEqual((yield* hmr.reload)._tag, "Reloaded")
			yield* reach(["a-2", "b-2"])
		}).pipe(run),
	)

	it.live("preserves import failures when an entry dependency is deleted", () =>
		Effect.gen(function* () {
			const { fs, directory, base, write, entry, load, hmr, reach } =
				yield* setup
			yield* write("dependency.mjs", "export const value = 1")
			yield* write("a.mjs", entry("a"))
			const plugin = yield* load("./a.mjs")
			yield* Graft.plugin(plugin)
			yield* reach(["a-1"])
			yield* fs.remove(`${directory}/dependency.mjs`)
			const failed = yield* Effect.exit(hmr.reload)
			assert(Exit.isFailure(failed))
			const error = Option.getOrThrow(Cause.findErrorOption(failed.cause))
			assert.strictEqual(error.stage, "import")
			assert(Predicate.hasProperty(error.cause, "code"))
			if (error.cause.code === "ERR_MODULE_NOT_FOUND") {
				assert(Predicate.hasProperty(error.cause, "url"))
				assert.strictEqual(
					error.cause.url,
					new URL("./dependency.mjs", base).href,
				)
			} else {
				assert.strictEqual(error.cause.code, "ENOENT")
				assert(Predicate.hasProperty(error.cause, "path"))
				assert.strictEqual(error.cause.path, `${directory}/dependency.mjs`)
			}
			yield* reach(["a-1"])
			yield* write("dependency.mjs", "export const value = 2")
			assert.strictEqual((yield* hmr.reload)._tag, "Reloaded")
			yield* reach(["a-2"])
		}).pipe(run),
	)

	it.live("reports CommonJS entries as skipped and requires a restart", () =>
		Effect.gen(function* () {
			const { write, load, hmr, reach, runtimePath, effectPath } = yield* setup
			yield* write(
				"plugin.cjs",
				`
const { Plugin } = require(${runtimePath});
const { Effect } = require(${effectPath});
module.exports = Plugin.make({ name: 'commonjs', apply: () => Effect.void });
`,
			)
			const plugin = yield* load("./plugin.cjs")
			yield* Graft.plugin(plugin)
			const result = yield* hmr.reload
			assert.strictEqual(result._tag, "Skipped")
			if (result._tag === "Skipped")
				assert.strictEqual(result.reason, "restart-required")
			yield* reach(["commonjs"])
		}).pipe(run),
	)

	it.live("watches a real directory and reloads a changed dependency", () =>
		Effect.gen(function* () {
			const { write, entry, load, hmr, directory, reach } = yield* setup
			yield* write("dependency.mjs", "export const value = 1")
			yield* write("a.mjs", entry("a"))
			const plugin = yield* load("./a.mjs")
			yield* Graft.plugin(plugin)
			const ready = yield* Deferred.make<void>()
			const watcher = yield* hmr
				.watch([directory], {
					onReady: () => Deferred.doneUnsafe(ready, Exit.void),
				})
				.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
			yield* Deferred.await(ready)
			yield* write("dependency.mjs", "export const value = 2")
			const results = yield* Fiber.join(watcher).pipe(
				Effect.timeout("5 seconds"),
			)
			assert.strictEqual(results[0]?._tag, "Reloaded")
			yield* reach(["a-2"])
		}).pipe(run),
	)

	it.live(
		"skips candidates that introduce CommonJS or native dependencies",
		() =>
			Effect.gen(function* () {
				const { write, entry, load, hmr, reach } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", entry("a"))
				const plugin = yield* load("./a.mjs")
				const fork = yield* Graft.plugin(plugin)
				yield* fork.await
				// Neither unsupported module may be evaluated during preparation.
				yield* write(
					"legacy.cjs",
					"throw new Error('must not evaluate CommonJS')",
				)
				yield* write("addon.node", "not a native binary")
				for (const name of ["legacy.cjs", "addon.node"]) {
					yield* write("a.mjs", `import './${name}';\n${entry("a")}`)
					const result = yield* hmr.reload
					assert.strictEqual(result._tag, "Skipped")
					if (result._tag === "Skipped") {
						assert.strictEqual(result.reason, "restart-required")
						assert(Arr.some(result.modules, Str.endsWith(name)))
					}
					yield* reach(["a-1"])
					yield* fork.await
				}
				yield* write("a.mjs", "export default {}")
				const invalid = yield* Effect.exit(hmr.reload)
				assert(Exit.isFailure(invalid))
				assert.strictEqual(
					Option.getOrThrow(Cause.findErrorOption(invalid.cause)).stage,
					"exports",
				)
				yield* write("dependency.mjs", "export const value = 2")
				yield* write("a.mjs", entry("a"))
				assert.strictEqual((yield* hmr.reload)._tag, "Reloaded")
				yield* reach(["a-2"])
			}).pipe(run),
	)

	it.live("rejects reloads after the owning scope closes", () =>
		Effect.gen(function* () {
			const hmr = yield* Effect.scoped(Hmr.make({ base: import.meta.url }))
			const exit = yield* Effect.exit(hmr.reload)
			assert(Exit.isFailure(exit))
			assert.strictEqual(
				Option.getOrThrow(Cause.findErrorOption(exit.cause)).stage,
				"closed",
			)
		}).pipe(run),
	)
})
