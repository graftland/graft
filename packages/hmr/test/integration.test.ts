// Native require bypasses Vite so integration tests exercise Node's module hooks.
import { createRequire } from "node:module"
import { TestClock } from "effect/testing"
import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	HashMap,
	Fiber,
	Option,
	Path,
	Predicate,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
	String,
} from "effect"
import {
	Plugin,
	type Graft as GraftType,
	type Plugin as PluginType,
} from "@graftland/graft"

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
	const hmr = yield* Hmr.make({ base, include: String.startsWith(root) })
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
		Stream.map((forks) => Array.map(forks, (fork) => fork.name)),
	)
	const reach = (expected: ReadonlyArray<string>) =>
		names.pipe(
			Stream.filter(
				(names) =>
					names.length === expected.length &&
					Array.every(names, (name, index) => name === expected[index]),
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
	it.live.each(["cjs", "mjs"])(
		"requires a restart for cached createRequire dependencies (%s)",
		(extension) =>
			Effect.gen(function* () {
				const { hmr, write } = yield* setup
				const runtime = yield* quote(runtimeUrl.href)
				const effect = yield* quote(effectUrl)
				const source = `import { Plugin } from ${runtime}; import { Effect } from ${effect};
import { createRequire } from '${extension === "cjs" ? "module" : "node:module"}'; const require = createRequire(import.meta.url);
export default Plugin.make({ name: 'required', apply: () => Effect.sync(() => require('./dep.${extension}')) });`
				yield* write(
					`dep.${extension}`,
					extension === "cjs"
						? "module.exports = { value: 1 }"
						: "export const value = 1",
				)
				yield* write("a.mjs", source)
				yield* write("b.mjs", source)
				const owner = yield* Scope.make()
				yield* Effect.addFinalizer((exit) => Scope.close(owner, exit))
				const first = yield* hmr
					.importerScoped("./a.mjs")
					.pipe(Scope.provide(owner))
				const a = yield* Graft.plugin(
					Option.getOrThrow(Plugin.fromModule(first)) as PluginType.Plugin<
						void,
						void,
						never
					>,
				)
				yield* a.await
				yield* a.dispose
				yield* Scope.close(owner, Exit.void)
				const second = yield* hmr.importerScoped("./b.mjs")
				const b = yield* Graft.plugin(
					Option.getOrThrow(Plugin.fromModule(second)) as PluginType.Plugin<
						void,
						void,
						never
					>,
				)
				yield* b.await
				yield* write(
					`dep.${extension}`,
					extension === "cjs"
						? "module.exports = { value: 2 }"
						: "export const value = 2",
				)
				const result = yield* hmr.reload
				assert.strictEqual(result._tag, "Skipped")
				if (result._tag === "Skipped")
					assert.strictEqual(result.reason, "restart-required")
			}).pipe(run),
	)

	it.effect(
		"reports native loading capabilities without events and suppresses unchanged status",
		() =>
			Effect.gen(function* () {
				const { fs, directory, hmr, write, entry, load } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("plugin.mjs", `import 'node:module'; ${entry("native")}`)
				yield* load("./plugin.mjs")
				const results =
					yield* Queue.unbounded<import("../src/index").WatchResult>()
				const watcher = yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runForEach((result) => Queue.offer(results, result)),
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						watch: () => Stream.never,
					}),
					Effect.forkChild,
				)
				const result = yield* Queue.take(results)
				assert.deepStrictEqual(
					result,
					Hmr.WatchResult.Skipped({
						reason: "restart-required",
						modules: ["node:module"],
					}),
				)
				yield* TestClock.adjust("3 seconds")
				const size = yield* Queue.size(results)
				assert.strictEqual(size, 0)
				yield* Fiber.interrupt(watcher)
			}).pipe(run),
	)

	it.live(
		"detects a retargeted entry symlink without native events or content changes",
		() =>
			Effect.gen(function* () {
				const { fs, directory, base, hmr, write, entry, reach } = yield* setup
				yield* fs.makeDirectory(`${directory}/one`)
				yield* fs.makeDirectory(`${directory}/two`)
				for (const name of ["one", "two"]) {
					yield* write(`${name}/plugin.mjs`, entry("linked"))
					yield* write(
						`${name}/dependency.mjs`,
						`export const value = '${name}'`,
					)
				}
				yield* fs.symlink("one/plugin.mjs", `${directory}/plugin.mjs`)
				const loaded = yield* hmr.importerScoped("./plugin.mjs")
				const fork = yield* Graft.plugin(
					Option.getOrThrow(Plugin.fromModule(loaded)) as PluginType.Plugin<
						void,
						void,
						never
					>,
				)
				yield* fork.await
				yield* reach(["linked-one"])
				yield* fs.remove(`${directory}/plugin.mjs`)
				yield* fs.symlink("two/plugin.mjs", `${directory}/plugin.mjs`)
				const result = yield* hmr.reload
				assert.deepStrictEqual(result, {
					_tag: "Skipped",
					reason: "restart-required",
					modules: [new URL("./plugin.mjs", base).href],
				})
				const polled = yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runHead,
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						watch: () => Stream.never,
					}),
				)
				assert.deepStrictEqual(Option.getOrThrow(polled), result)
				yield* reach(["linked-one"])
			}).pipe(run),
	)

	it.live(
		"reconciles a reachable helper link and releases its resolution with its lease",
		() =>
			Effect.gen(function* () {
				const { fs, directory, base, hmr, write, entry, load, reach } =
					yield* setup
				for (const name of ["one", "two"]) {
					yield* fs.makeDirectory(`${directory}/${name}`)
					yield* write(
						`${name}/helper.mjs`,
						"export { value } from './value.mjs'",
					)
					yield* write(`${name}/value.mjs`, `export const value = '${name}'`)
				}
				yield* fs.symlink("one/helper.mjs", `${directory}/helper.mjs`)
				yield* write("dependency.mjs", "export { value } from './helper.mjs'")
				yield* write("plugin.mjs", entry("linked"))
				const owner = yield* Scope.make()
				yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
				const loaded = yield* hmr
					.importerScoped("./plugin.mjs")
					.pipe(Effect.provideService(Scope.Scope, owner))
				const plugin = Option.getOrThrow(
					Plugin.fromModule(loaded),
				) as PluginType.Plugin<void, void, never>
				const fork = yield* Graft.plugin(plugin)
				yield* fork.await
				yield* reach(["linked-one"])
				yield* fs.remove(`${directory}/helper.mjs`)
				yield* fs.symlink("two/helper.mjs", `${directory}/helper.mjs`)
				const expected = Hmr.WatchResult.Skipped({
					reason: "restart-required",
					modules: [new URL("./helper.mjs", base).href],
				})
				const result = yield* hmr.reload
				assert.deepStrictEqual(result, expected)
				const polled = yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runHead,
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						watch: () => Stream.never,
					}),
				)
				assert.deepStrictEqual(Option.getOrThrow(polled), expected)
				yield* reach(["linked-one"])
				yield* fork.dispose
				yield* Scope.close(owner, Exit.void)
				yield* fs.remove(`${directory}/helper.mjs`)
				yield* fs.makeDirectory(`${directory}/helper.mjs`)
				const empty = yield* hmr.reload
				assert.strictEqual(empty._tag, "Reloaded")
				yield* write(
					"remaining.mjs",
					String.replace(
						"./dependency.mjs",
						"./one/value.mjs",
					)(entry("remaining")),
				)
				const remaining = yield* load("./remaining.mjs")
				yield* Graft.plugin(remaining)
				yield* reach(["remaining-one"])
				yield* write("one/value.mjs", "export const value = 'updated'")
				const updated = yield* hmr
					.watch([directory], { recursive: true, debounce: 0 })
					.pipe(
						Stream.runHead,
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							watch: () => Stream.never,
						}),
					)
				assert.strictEqual(Option.getOrThrow(updated)._tag, "Reloaded")
				yield* reach(["remaining-updated"])
			}).pipe(run),
	)

	it.live("retains helper resolutions discovered by a failed candidate", () =>
		Effect.gen(function* () {
			const { fs, directory, base, hmr, write, entry, load, reach } =
				yield* setup
			yield* write("dependency.mjs", "export const value = 1")
			yield* write("plugin.mjs", entry("running"))
			const plugin = yield* load("./plugin.mjs")
			yield* Graft.plugin(plugin)
			yield* reach(["running-1"])
			yield* write("one.mjs", "export const value = 2")
			yield* write("two.mjs", "export const value = 3")
			yield* fs.symlink("one.mjs", `${directory}/helper.mjs`)
			yield* write(
				"dependency.mjs",
				"export { value } from './helper.mjs'; throw new Error('Candidate failed')",
			)
			const failed = yield* Effect.exit(hmr.reload)
			assert(Exit.isFailure(failed))
			yield* fs.remove(`${directory}/helper.mjs`)
			yield* fs.symlink("two.mjs", `${directory}/helper.mjs`)
			const result = yield* hmr.reload
			assert.deepStrictEqual(
				result,
				Hmr.WatchResult.Skipped({
					reason: "restart-required",
					modules: [new URL("./helper.mjs", base).href],
				}),
			)
			const polled = yield* hmr.watch([directory], { debounce: 0 }).pipe(
				Stream.runHead,
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					watch: () => Stream.never,
				}),
			)
			assert.deepStrictEqual(Option.getOrThrow(polled), result)
			yield* reach(["running-1"])
		}).pipe(run),
	)

	it.live.each(["entry", "helper", "new helper"])(
		"rejects a %s retargeted while a candidate import is suspended",
		(kind) =>
			Effect.gen(function* () {
				const { fs, directory, base, hmr, write, entry, load, reach } =
					yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("one.mjs", entry("one"))
				yield* write("two.mjs", entry("two"))
				const link = kind === "entry" ? "plugin.mjs" : "helper.mjs"
				if (kind !== "entry")
					yield* write(
						"plugin.mjs",
						kind === "helper"
							? "export { default } from './helper.mjs'"
							: "export { default } from './one.mjs'",
					)
				yield* fs.symlink("one.mjs", `${directory}/${link}`)
				const plugin = yield* load("./plugin.mjs")
				yield* Graft.plugin(plugin)
				yield* reach(["one-1"])
				const entered = yield* Deferred.make<void>()
				const release = Promise.withResolvers<void>()
				const key = `graft-symlink:${directory}`
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
				yield* write("dependency.mjs", "export const value = 2")
				if (kind === "new helper")
					yield* write("plugin.mjs", "export { default } from './helper.mjs'")
				yield* write(
					"one.mjs",
					`globalThis[${keySource}].enter(); await globalThis[${keySource}].release;\n${entry("one")}`,
				)
				yield* Effect.gen(function* () {
					const reloading = yield* hmr.reload.pipe(Effect.forkChild)
					yield* Deferred.await(entered)
					yield* fs.remove(`${directory}/${link}`)
					yield* fs.symlink("two.mjs", `${directory}/${link}`)
					release.resolve()
					const result = yield* Fiber.join(reloading)
					assert.deepStrictEqual(result, {
						_tag: "Skipped",
						reason: "restart-required",
						modules: [new URL(`./${link}`, base).href],
					})
					yield* reach(["one-1"])
				}).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
			}).pipe(run),
	)

	it.effect.each(["committed", "failed"])(
		"reconciles a reverted snapshot against the %s import attempt",
		(outcome) =>
			Effect.gen(function* () {
				const { fs, directory, hmr, write, entry, load, reach } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", entry("a"))
				const plugin = yield* load("./a.mjs")
				const fork = yield* Graft.plugin(plugin)
				yield* fork.await
				yield* write("dependency.mjs", "export const value = 2")
				const armed = yield* Ref.make(true)
				const ready = yield* Deferred.make<void>()
				const results =
					yield* Queue.unbounded<import("../src/index").WatchResult>()
				const watcher = yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runForEach((result) => Queue.offer(results, result)),
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						watch: () =>
							Stream.unwrap(
								Deferred.succeed(ready, undefined).pipe(
									Effect.as(Stream.never),
								),
							),
						readFile: (path) =>
							fs
								.readFile(path)
								.pipe(
									Effect.tap(() =>
										path !== `${directory}/dependency.mjs`
											? Effect.void
											: Ref.getAndSet(armed, false).pipe(
													Effect.flatMap((armed) =>
														armed
															? write(
																	"dependency.mjs",
																	outcome === "committed"
																		? "export const value = 3"
																		: "export const value = ;",
																)
															: Effect.void,
													),
												),
									),
								),
					}),
					Effect.forkScoped,
				)
				yield* Deferred.await(ready)
				yield* TestClock.adjust("1 second")
				const first = yield* Queue.take(results)
				assert.strictEqual(
					first._tag,
					outcome === "committed" ? "Reloaded" : "Failed",
				)
				yield* reach([outcome === "committed" ? "a-3" : "a-1"])
				// The disk returns to the bytes observed before the import, without an event.
				yield* write("dependency.mjs", "export const value = 2")
				yield* TestClock.adjust("1 second")
				const second = yield* Queue.take(results)
				assert.strictEqual(second._tag, "Reloaded")
				yield* reach(["a-2"])
				yield* TestClock.adjust("3 seconds")
				const redundant = yield* Queue.size(results)
				assert.strictEqual(redundant, 0)
				yield* Fiber.interrupt(watcher)
			}).pipe(run),
	)

	it.effect(
		"uses the newest imported baseline while an older failed lease remains",
		() =>
			Effect.gen(function* () {
				const { fs, directory, hmr, write, entry } = yield* setup
				yield* write("a.mjs", entry("a"))
				yield* write("dependency.mjs", "export const value = ;")
				const failed = yield* Effect.exit(hmr.importerScoped("./a.mjs"))
				assert(Exit.isFailure(failed))
				yield* hmr.reload
				yield* write("dependency.mjs", "export const value = 2")
				yield* hmr.importerScoped("./a.mjs")
				const ready = yield* Deferred.make<void>()
				const results =
					yield* Queue.unbounded<import("../src/index").WatchResult>()
				const reads = yield* Ref.make(0)
				const contents: HashMap.HashMap<string, Uint8Array> =
					yield* Effect.forEach(["a.mjs", "dependency.mjs"], (name) =>
						fs
							.readFile(`${directory}/${name}`)
							.pipe(
								Effect.map((bytes) => [`${directory}/${name}`, bytes] as const),
							),
					).pipe(Effect.map(HashMap.fromIterable))
				const watcher = yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runForEach((result) => Queue.offer(results, result)),
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						realPath: Effect.succeed,
						watch: () =>
							Stream.unwrap(
								Deferred.succeed(ready, undefined).pipe(
									Effect.as(Stream.never),
								),
							),
						readFile: (path) =>
							Effect.fromOption(HashMap.get(contents, path)).pipe(
								Effect.orDie,
								Effect.tap(() => Ref.update(reads, (n) => n + 1)),
							),
					}),
					Effect.forkScoped,
				)
				yield* Deferred.await(ready)
				yield* TestClock.adjust("3 seconds")
				const readCount = yield* Ref.get(reads)
				const count = yield* Queue.size(results)
				assert.isAbove(readCount, 0)
				assert.strictEqual(count, 0)
				yield* Fiber.interrupt(watcher)
			}).pipe(run),
	)

	it.live.each([false, true])(
		"rejects overlapping export identities (reverse order: %s)",
		(reverse) =>
			Effect.gen(function* () {
				const { fs, directory, base } = yield* setup
				const hmr = yield* Hmr.make({
					base,
					include: (url) =>
						String.startsWith(new URL(".", base).href)(url) &&
						!String.includes("/node_modules/")(url),
				})
				const runtimeSource = yield* quote(runtimeUrl.href)
				const effectSource = yield* quote(effectUrl)
				yield* fs.makeDirectory(`${directory}/node_modules/library`, {
					recursive: true,
				})
				yield* fs.writeFileString(
					`${directory}/node_modules/library/index.mjs`,
					`
import { Plugin } from ${runtimeSource}; import { Effect } from ${effectSource};
export const p = Plugin.make({ name: 'P', apply: () => Effect.void });
export const q = Plugin.make({ name: 'Q', apply: () => Effect.void });
export const r = Plugin.make({ name: 'R', apply: () => Effect.void });`,
				)
				const write = (file: string, key: string) =>
					fs.writeFileString(
						`${directory}/${file}.mjs`,
						`export { ${key} as default } from './node_modules/library/index.mjs'`,
					)
				yield* write("a", "p")
				yield* write("b", "q")
				for (const file of reverse ? ["b", "a"] : ["a", "b"]) {
					const module = yield* hmr.importerScoped(`./${file}.mjs`)
					const plugin = Option.getOrThrow(Plugin.fromModule(module))
					const fork = yield* Graft.plugin(
						plugin as PluginType.Plugin<void, void, never>,
					)
					yield* fork.await
				}
				yield* write("a", "q")
				yield* write("b", "r")
				const result = yield* hmr.reload
				assert(result._tag === "Skipped")
				assert.strictEqual(result.reason, "identity-conflict")
				assert.sameMembers(
					[...result.modules],
					[new URL("./a.mjs", base).href, new URL("./b.mjs", base).href],
				)
				const tree = yield* Stream.runHead(Graft.forks)
				assert.sameMembers(
					Array.map(Option.getOrThrow(tree), (fork) => fork.name),
					["P", "Q"],
				)
			}).pipe(run),
	)

	it.live.each(["invalid dependency", "missing dependency"])(
		"keeps a failed import's graph available for polling (%s)",
		(failure) =>
			Effect.gen(function* () {
				const { fs, directory, write, entry, hmr, reach } = yield* setup
				yield* write("a.mjs", entry("a"))
				if (failure === "invalid dependency")
					yield* write("dependency.mjs", "export const value = ;")
				const initial = yield* Effect.exit(hmr.importerScoped("./a.mjs"))
				assert(Exit.isFailure(initial))
				yield* write("dependency.mjs", "export const value = 2")
				const observed = yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runHead,
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						watch: () => Stream.never,
					}),
				)
				assert.deepStrictEqual(Option.getOrThrow(observed), {
					_tag: "Reloaded",
					entries: [],
				})
				const module = yield* hmr.importerScoped("./a.mjs")
				const plugin = Option.getOrThrow(Plugin.fromModule(module))
				yield* Graft.plugin(plugin)
				yield* reach(["a-2"])
			}).pipe(run),
	)

	it.live(
		"reconciles a failed candidate's new dependency and retires the old graph after commit",
		() =>
			Effect.gen(function* () {
				const { fs, directory, write, entry, hmr, reach, load } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", entry("a"))
				const plugin = yield* load("./a.mjs")
				yield* Graft.plugin(plugin)
				yield* reach(["a-1"])
				yield* write(
					"a.mjs",
					String.replace("./dependency.mjs", "./new.mjs")(entry("a")),
				)
				yield* write("new.mjs", "export const value = ;")
				const failed = yield* Effect.exit(hmr.reload)
				assert(Exit.isFailure(failed))
				const poll = hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runHead,
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						watch: () => Stream.never,
					}),
				)
				yield* write("new.mjs", "export const value = 2")
				const recovered = yield* poll
				assert.strictEqual(Option.getOrThrow(recovered)._tag, "Reloaded")
				yield* reach(["a-2"])
				yield* fs.remove(`${directory}/dependency.mjs`)
				yield* fs.makeDirectory(`${directory}/dependency.mjs`)
				yield* write("new.mjs", "export const value = 3")
				const reloaded = yield* poll
				assert.strictEqual(Option.getOrThrow(reloaded)._tag, "Reloaded")
				yield* reach(["a-3"])
			}).pipe(run),
	)

	it.live.each(["entry", "dependency", "failed attempt", "shared dependency"])(
		"does not poll a released %s whose path became a directory",
		(target) =>
			Effect.gen(function* () {
				const { fs, directory, base, write, entry, hmr } = yield* setup
				const owner = yield* Scope.make()
				yield* Effect.addFinalizer((exit) => Scope.close(owner, exit))
				yield* write("dependency.mjs", "export const value = 1")
				yield* write(
					"a.mjs",
					target === "failed attempt" ? "export default ;" : entry("a"),
				)
				const source = yield* quote(runtimeUrl.href)
				const effect = yield* quote(effectUrl)
				yield* write(
					"b.mjs",
					`import { Plugin } from ${source}; import { Effect } from ${effect}; export default Plugin.make({name:'b1',apply:()=>Effect.void})`,
				)
				const first = yield* hmr
					.importerScoped("./a.mjs")
					.pipe(Scope.provide(owner), Effect.exit)
				assert.strictEqual(Exit.isFailure(first), target === "failed attempt")
				if (target === "shared dependency") yield* write("b.mjs", entry("b"))
				yield* hmr.importerScoped("./b.mjs")
				yield* Scope.close(owner, Exit.void)
				const retired = target === "dependency" ? "dependency.mjs" : "a.mjs"
				yield* fs.remove(`${directory}/${retired}`)
				yield* fs.makeDirectory(`${directory}/${retired}`)
				yield* write(
					"b.mjs",
					`import { Plugin } from ${source}; import { Effect } from ${effect}; export default Plugin.make({name:'b2',apply:()=>Effect.void})`,
				)
				const result = yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runHead,
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						watch: () => Stream.never,
					}),
				)
				assert.deepStrictEqual(Option.getOrThrow(result), {
					_tag: "Reloaded",
					entries: [new URL("./b.mjs", base).href],
				})
			}).pipe(run),
	)

	it.live(
		"rejects divergent replacements of a shared plugin before changing any fork",
		() =>
			Effect.gen(function* () {
				const { write, entry, load, hmr, reach, base } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", "export { default } from './b.mjs'")
				yield* write("b.mjs", entry("shared"))
				const a = yield* load("./a.mjs")
				const b = yield* load("./b.mjs")
				assert.strictEqual(a, b)
				yield* Graft.plugin(a)
				yield* Graft.plugin(b)
				yield* reach(["shared-1", "shared-1"])
				yield* write("a.mjs", entry("a"))
				yield* write("b.mjs", entry("b"))
				const result = yield* hmr.reload
				assert(result._tag === "Skipped")
				assert.strictEqual(result.reason, "ambiguous-exports")
				assert.sameMembers(
					[...result.modules],
					[new URL("./a.mjs", base).href, new URL("./b.mjs", base).href],
				)
				yield* reach(["shared-1", "shared-1"])
				// Returning to one shared export is recoverable without poisoning aliases.
				yield* write("a.mjs", "export { default } from './b.mjs'")
				const recovered = yield* hmr.reload
				assert.strictEqual(recovered._tag, "Reloaded")
				yield* reach(["b-1", "b-1"])
			}).pipe(run),
	)

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
			assert(Array.every(results, (result) => result._tag === "Reloaded"))
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

	it.live.each([false, true])(
		"records CommonJS dependencies imported during activation (after reload: %s)",
		(afterReload) =>
			Effect.gen(function* () {
				const { write, load, hmr, base } = yield* setup
				const runtimeSource = yield* quote(runtimeUrl.href)
				const effectSource = yield* quote(effectUrl)
				yield* write("legacy.cjs", "module.exports = { value: 1 }")
				yield* write(
					"lazy.mjs",
					`
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
export default Plugin.make({ name: 'lazy', apply: () =>
  Effect.promise(() => import('./legacy.cjs')).pipe(
    Effect.flatMap(({ default: legacy }) => legacy.value === 1
      ? Effect.void : Effect.die('Unexpected legacy value'))
  )
});
`,
				)
				const plugin = yield* load("./lazy.mjs")
				if (afterReload) {
					const initial = yield* hmr.reload
					assert.strictEqual(initial._tag, "Reloaded")
				}
				const fork = yield* Graft.plugin(plugin)
				yield* fork.await
				yield* write("legacy.cjs", "module.exports = { value: 2 }")
				const result = yield* hmr.reload
				assert.deepStrictEqual(result, {
					_tag: "Skipped",
					reason: "restart-required",
					modules: [new URL("./legacy.cjs", base).href],
				})
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
			const reloaded = yield* Deferred.make<void>()
			const watching = yield* hmr
				.watch([directory], {
					onReady: () => Deferred.doneUnsafe(ready, Exit.void),
				})
				.pipe(
					Stream.runForEach((result) => {
						if (result._tag === "Failed")
							return Effect.logWarning(
								"Transient HMR reload failure",
								result.cause,
							)
						assert.strictEqual(result._tag, "Reloaded")
						return Deferred.succeed(reloaded, undefined)
					}),
					Effect.forkScoped,
				)
			yield* Effect.gen(function* () {
				yield* Deferred.await(ready)
				yield* write("dependency.mjs", "export const value = 2")
				// Old events may arrive after installation. Observe the new code,
				// and wait for the result consumer independently of the fork tree.
				yield* reach(["a-2"])
				yield* Deferred.await(reloaded)
			}).pipe(
				Effect.raceFirst(
					Fiber.join(watching).pipe(
						Effect.andThen(
							Effect.die(
								new Error(
									"The watcher ended before the changed plugin was observed",
								),
							),
						),
					),
				),
			)
		}).pipe(run),
	)

	it.live(
		"reconciles a changed dependency when the watcher delivers no events",
		() =>
			Effect.gen(function* () {
				const { fs, write, entry, load, hmr, directory, reach } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", entry("a"))
				const plugin = yield* load("./a.mjs")
				yield* Graft.plugin(plugin)
				const ready = yield* Deferred.make<void>()
				const watching = yield* hmr
					.watch([directory], {
						onReady: () => Deferred.doneUnsafe(ready, Exit.void),
						debounce: 0,
					})
					.pipe(
						Stream.take(1),
						Stream.runHead,
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							// Model the native startup gap: registration succeeds, but the
							// operating system never reports the following write.
							watch: (_path, options) =>
								Stream.callback(() => Effect.sync(() => options?.onReady?.())),
						}),
						Effect.forkScoped,
					)
				yield* Deferred.await(ready)
				yield* write("dependency.mjs", "export const value = 2")
				const outcome = yield* Fiber.join(watching)
				const result = Option.getOrThrow(outcome)
				if (result._tag === "Failed")
					return yield* Effect.failCause(result.cause)
				assert.strictEqual(result._tag, "Reloaded")
				yield* reach(["a-2"])
			}).pipe(run),
	)

	it.live(
		"recovers from an incomplete write without another native event",
		() =>
			Effect.gen(function* () {
				const { fs, write, entry, load, hmr, directory, reach } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", entry("a"))
				const plugin = yield* load("./a.mjs")
				yield* Graft.plugin(plugin)
				const ready = yield* Deferred.make<void>()
				const failed =
					yield* Deferred.make<Cause.Cause<import("../src/index").HmrError>>()
				const events = yield* Queue.unbounded<FileSystem.WatchEvent>()
				const watching = yield* hmr
					.watch([directory], {
						debounce: 0,
						onReady: () => Deferred.doneUnsafe(ready, Exit.void),
					})
					.pipe(
						Stream.tap((result) =>
							result._tag === "Failed"
								? Deferred.succeed(failed, result.cause)
								: Effect.void,
						),
						Stream.take(2),
						Stream.runCollect,
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							watch: (_path, options) =>
								Stream.unwrap(
									Effect.sync(() => {
										options?.onReady?.()
										return Stream.fromQueue(events)
									}),
								),
						}),
						Effect.forkScoped,
					)
				yield* Deferred.await(ready)
				// Hold the file between truncation and its final contents until the
				// actual native importer has failed. The completing write has no event.
				yield* write("dependency.mjs", "")
				yield* Queue.offer(events, { _tag: "Update", path: "dependency.mjs" })
				const cause = yield* Deferred.await(failed)
				const error = Option.getOrThrow(Cause.findErrorOption(cause))
				assert.strictEqual(error.stage, "import")
				assert(Predicate.hasProperty(error.cause, "message"))
				assert.include(
					String.String(error.cause.message),
					"does not provide an export named 'value'",
				)
				yield* write("dependency.mjs", "export const value = 2")
				const results = yield* Fiber.join(watching)
				assert.deepStrictEqual(
					Array.map(results, (result) => result._tag),
					["Failed", "Reloaded"],
				)
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
						assert(Array.some(result.modules, String.endsWith(name)))
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
