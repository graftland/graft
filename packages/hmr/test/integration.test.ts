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
	HashSet,
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
const { Hmr, Graft, modules, nativeImport } = createRequire(import.meta.url)(
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

const watchEvents = Effect.fnUntraced(function* (
	hmr: import("../src/index").Hmr,
	directory: string,
	fs: FileSystem.FileSystem,
) {
	const events = yield* Queue.unbounded<FileSystem.WatchEvent>()
	const results = yield* Queue.unbounded<import("../src/index").WatchResult>()
	const ready = yield* Deferred.make<void>()
	yield* hmr
		.watch([directory], {
			debounce: 0,
			onReady: () => Deferred.doneUnsafe(ready, Exit.void),
		})
		.pipe(
			Stream.runForEach((result) => Queue.offer(results, result)),
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
	return {
		events,
		results,
		changed: (path: string) =>
			Queue.offer(events, { _tag: "Update", path }).pipe(
				Effect.andThen(Queue.take(results)),
			),
	}
})

describe("native HMR", () => {
	it.live(
		"invalidates importers while reusing clean shared dependencies and independent entries",
		() =>
			Effect.gen(function* () {
				const { hmr, write, entry, fs, directory } = yield* setup
				yield* write(
					"dependency.mjs",
					"export const value = 1; export const identity = {}",
				)
				for (const name of ["a", "b"])
					yield* write(
						`${name}.mjs`,
						`${entry(name)}; export { identity } from './dependency.mjs'`,
					)
				yield* write(
					"c.mjs",
					String.replace(
						"import { value } from './dependency.mjs';",
						"const value = 1;",
					)(entry("c")),
				)
				const a = yield* hmr.importerScoped("./a.mjs")
				const b = yield* hmr.importerScoped("./b.mjs")
				const c = yield* hmr.importerScoped("./c.mjs")
				const { changed } = yield* watchEvents(hmr, directory, fs)
				yield* write(
					"a.mjs",
					`${entry("edited")}; export { identity } from './dependency.mjs'`,
				)
				const one = yield* changed("a.mjs")
				assert.deepStrictEqual(
					one,
					Hmr.WatchResult.Reloaded({
						entries: [new URL("a.mjs", `file://${directory}/`).href],
					}),
				)
				const nextA = yield* hmr.importerScoped("./a.mjs")
				const sameB = yield* hmr.importerScoped("./b.mjs")
				assert.notStrictEqual(nextA, a)
				assert.strictEqual(sameB, b)
				assert(
					Predicate.hasProperty(nextA, "identity") &&
						Predicate.hasProperty(b, "identity"),
				)
				assert.strictEqual(nextA.identity, b.identity)
				yield* write(
					"dependency.mjs",
					"export const value = 2; export const identity = {}",
				)
				const shared = yield* changed("dependency.mjs")
				assert(shared._tag === "Reloaded")
				assert.strictEqual(shared.entries.length, 2)
				const newestA = yield* hmr.importerScoped("./a.mjs")
				const newestB = yield* hmr.importerScoped("./b.mjs")
				const sameC = yield* hmr.importerScoped("./c.mjs")
				assert(
					Predicate.hasProperty(newestA, "identity") &&
						Predicate.hasProperty(newestB, "identity"),
				)
				assert.strictEqual(newestA.identity, newestB.identity)
				assert.notStrictEqual(newestA.identity, b.identity)
				assert.strictEqual(sameC, c)
				const forced = yield* hmr.reload
				assert(forced._tag === "Reloaded")
				assert.strictEqual(forced.entries.length, 3)
				const forcedC = yield* hmr.importerScoped("./c.mjs")
				assert.notStrictEqual(forcedC, c)
			}).pipe(run),
	)

	it.live(
		"retries the full dirty closure after a failed incremental candidate",
		() =>
			Effect.gen(function* () {
				const { hmr, write, entry, fs, directory, load, reach } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				for (const name of ["a", "b"]) {
					yield* write(`${name}.mjs`, entry(name))
					const plugin = yield* load(`./${name}.mjs`)
					const fork = yield* Graft.plugin(plugin)
					yield* fork.await
				}
				const { changed } = yield* watchEvents(hmr, directory, fs)
				yield* write(
					"dependency.mjs",
					"import './new.mjs'; export const value = 2",
				)
				const failed = yield* changed("dependency.mjs")
				assert.strictEqual(failed._tag, "Failed")
				yield* reach(["a-1", "b-1"])
				yield* write("new.mjs", "export const ready = true")
				const recovered = yield* changed("new.mjs")
				assert(recovered._tag === "Reloaded")
				assert.strictEqual(recovered.entries.length, 2)
				yield* reach(["a-2", "b-2"])
			}).pipe(run),
	)

	it.live(
		"keeps late dynamic imports attached to their original module view",
		() =>
			Effect.gen(function* () {
				const { hmr, write, entry, fs, directory } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write(
					"a.mjs",
					`${entry("a")}; export const lazy = () => import('./dependency.mjs')`,
				)
				const original = yield* hmr.importerScoped("./a.mjs")
				assert(
					Predicate.hasProperty(original, "lazy") &&
						typeof original.lazy === "function",
				)
				const lazy = original.lazy as () => Promise<{ value: number }>
				const { changed } = yield* watchEvents(hmr, directory, fs)
				yield* write("dependency.mjs", "export const value = 2")
				const result = yield* changed("dependency.mjs")
				assert.strictEqual(result._tag, "Reloaded")
				const old = yield* Effect.promise(lazy)
				assert.strictEqual(old.value, 1)
				const current = yield* hmr.importerScoped("./a.mjs")
				assert(
					Predicate.hasProperty(current, "lazy") &&
						typeof current.lazy === "function",
				)
				const currentLazy = current.lazy as () => Promise<{ value: number }>
				const latest = yield* Effect.promise(currentLazy)
				assert.strictEqual(latest.value, 2)
			}).pipe(run),
	)

	it.live("closes cyclic importer graphs during incremental reload", () =>
		Effect.gen(function* () {
			const { hmr, write, entry, fs, directory, load } = yield* setup
			yield* write(
				"dependency.mjs",
				"import {read} from './cycle.mjs'; export const value = read(); export function base() { return 1 }",
			)
			yield* write(
				"cycle.mjs",
				"import {base} from './dependency.mjs'; export const read = () => base()",
			)
			yield* write("a.mjs", entry("cycle"))
			const first = yield* load("./a.mjs")
			assert.strictEqual(first.name, "cycle-1")
			const { changed } = yield* watchEvents(hmr, directory, fs)
			yield* write(
				"cycle.mjs",
				"import {base} from './dependency.mjs'; export const read = () => base() + 1",
			)
			const result = yield* changed("cycle.mjs")
			assert.strictEqual(result._tag, "Reloaded")
			const next = yield* load("./a.mjs")
			assert.strictEqual(next.name, "cycle-2")
		}).pipe(run),
	)

	it.live(
		"validates the entire shared Plugin identity group before incremental publication",
		() =>
			Effect.gen(function* () {
				const { hmr, write, entry, fs, directory, load, reach } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("b.mjs", entry("shared"))
				yield* write("a.mjs", "export {default} from './b.mjs'")
				const a = yield* load("./a.mjs")
				const b = yield* load("./b.mjs")
				assert.strictEqual(a, b)
				const fork = yield* Graft.plugin(a)
				yield* fork.await
				const { changed } = yield* watchEvents(hmr, directory, fs)
				yield* write("a.mjs", entry("split"))
				const result = yield* changed("a.mjs")
				assert(result._tag === "Skipped")
				assert.strictEqual(result.reason, "ambiguous-exports")
				yield* reach(["shared-1"])
			}).pipe(run),
	)

	it.live(
		"preserves a released entry identity and dependency graph on a new lease",
		() =>
			Effect.gen(function* () {
				const { hmr, write, entry, fs, directory, load } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", entry("a"))
				const original = yield* hmr
					.importerScoped("./a.mjs")
					.pipe(Effect.scoped)
				const reacquired = yield* hmr.importerScoped("./a.mjs")
				assert.strictEqual(reacquired, original)
				const { changed } = yield* watchEvents(hmr, directory, fs)
				yield* write("dependency.mjs", "export const value = 2")
				const result = yield* changed("dependency.mjs")
				assert.strictEqual(result._tag, "Reloaded")
				const next = yield* load("./a.mjs")
				assert.strictEqual(next.name, "a-2")
			}).pipe(run),
	)

	it.live(
		"restores transitive observations when an old route reconnects a cached instance",
		() =>
			Effect.gen(function* () {
				const { write, base } = yield* setup
				yield* write("a.mjs", "export const lazy = () => import('./b.mjs')")
				yield* write("b.mjs", "export { value } from './c.mjs'")
				yield* write("c.mjs", "export const value = 1")
				yield* write("d.mjs", "export const value = 1")
				const hooks = yield* Effect.acquireRelease(
					Effect.sync(() =>
						modules(base, String.startsWith(new URL(".", base).href)),
					),
					(hooks) => Effect.sync(hooks.close),
				)
				const generation = hooks.prepare()
				hooks.start(generation)
				const a = yield* Effect.promise(() =>
					nativeImport(hooks.request("./a.mjs")),
				)
				const b = yield* Effect.promise(() =>
					nativeImport(hooks.request("./b.mjs")),
				)
				yield* Effect.promise(() => nativeImport(hooks.request("./d.mjs")))
				hooks.discard()
				const active = Array.map(["a.mjs", "d.mjs"], (name) => ({
					url: new URL(name, base).href,
					generation,
				}))
				const next = hooks.prepare(
					active,
					hooks.invalidated(active, HashSet.make(new URL("d.mjs", base).href)),
				)
				hooks.start(next, true)
				yield* Effect.promise(() => nativeImport(hooks.request("./d.mjs")))
				hooks.discard()
				const committed = Array.map(active, (attempt) => ({
					...attempt,
					generation: next,
				}))
				hooks.collect(committed)
				assert.isFalse(
					HashMap.has(hooks.files(committed), new URL("c.mjs", base).href),
				)
				assert(Predicate.hasProperty(a, "lazy") && typeof a.lazy === "function")
				const lazy = a.lazy as () => Promise<unknown>
				const reconnected = yield* Effect.promise(lazy)
				assert.strictEqual(reconnected, b)
				const c = new URL("c.mjs", base).href
				const observed = hooks.files(committed)
				assert(
					HashMap.has(observed, c),
					"The reconnected instance must retain its static dependencies",
				)
				assert.isString(Option.getOrThrow(HashMap.get(observed, c)).content)
				assert(
					hooks.affected(
						committed[0]!,
						hooks.invalidated(committed, HashSet.make(c)),
					),
				)
				assert(
					Array.some(
						hooks.resolutions(committed),
						(attempt) => attempt.request === c,
					),
				)
			}).pipe(run),
	)

	it.live(
		"requires restart after an old route reconnects a cached native capability",
		() =>
			Effect.gen(function* () {
				const { hmr, write, entry, fs, directory } = yield* setup
				const independent = (name: string) =>
					String.replace(
						"import { value } from './dependency.mjs';",
						"const value = 1;",
					)(entry(name))
				yield* write(
					"a.mjs",
					`${independent("a")}; export const lazy = () => import('./b.mjs')`,
				)
				yield* write("b.mjs", `${independent("b")}; import './c.mjs'`)
				yield* write(
					"c.mjs",
					"import { createRequire } from 'node:module'; export const native = createRequire(import.meta.url)",
				)
				yield* write("d.mjs", independent("d"))
				const a = yield* hmr.importerScoped("./a.mjs")
				const b = yield* hmr.importerScoped("./b.mjs").pipe(Effect.scoped)
				yield* hmr.importerScoped("./d.mjs")
				const { changed } = yield* watchEvents(hmr, directory, fs)
				yield* write("d.mjs", independent("edited"))
				assert.strictEqual((yield* changed("d.mjs"))._tag, "Reloaded")
				assert(Predicate.hasProperty(a, "lazy") && typeof a.lazy === "function")
				const lazy = a.lazy as () => Promise<unknown>
				const reconnected = yield* Effect.promise(lazy)
				assert.strictEqual(reconnected, b)
				const result = yield* hmr.reload
				assert.deepStrictEqual(
					result,
					Hmr.WatchResult.Skipped({
						reason: "restart-required",
						modules: ["node:module"],
					}),
				)
			}).pipe(run),
	)

	it.live(
		"retains cached instance facts until close without observing unleased entries",
		() =>
			Effect.gen(function* () {
				const { write, base } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("b.mjs", "export const value = 1")
				const hooks = yield* Effect.acquireRelease(
					Effect.sync(() =>
						modules(base, String.startsWith(new URL(".", base).href)),
					),
					(hooks) => Effect.sync(hooks.close),
				)
				let generation = hooks.prepare()
				hooks.start(generation)
				yield* write(
					"a.mjs",
					"export {value} from './dependency.mjs'; export const lazy = () => import('./dependency.mjs')",
				)
				const first = yield* Effect.promise(() =>
					nativeImport(hooks.request("./a.mjs")),
				)
				yield* Effect.promise(() => nativeImport(hooks.request("./b.mjs")))
				hooks.discard()
				const a = new URL("a.mjs", base).href
				let attempts = [
					{ url: a, generation },
					{ url: new URL("b.mjs", base).href, generation },
				]
				hooks.collect(attempts)
				for (let i = 0; i < 12; i++) {
					yield* write(
						"a.mjs",
						`export {value} from './dependency.mjs'; export const revision = ${i}`,
					)
					generation = hooks.prepare(
						attempts,
						hooks.invalidated(attempts, HashSet.make(a)),
					)
					hooks.start(generation, true)
					yield* Effect.promise(() => nativeImport(hooks.request("./a.mjs")))
					hooks.discard()
					attempts = Array.map(attempts, (attempt) =>
						attempt.url === a ? { ...attempt, generation } : attempt,
					)
					hooks.collect(attempts)
					assert.strictEqual(hooks.counts().sources, i + 4)
					assert.strictEqual(hooks.counts().edges, i + 2)
				}
				hooks.collect([])
				assert.strictEqual(HashMap.size(hooks.files([])), 0)
				assert.strictEqual(hooks.counts().sources, 15)
				assert.strictEqual(hooks.counts().edges, 13)
				assert(
					Predicate.hasProperty(first, "lazy") &&
						typeof first.lazy === "function",
				)
				const lazy = first.lazy as () => Promise<{ value: number }>
				const old = yield* Effect.promise(lazy)
				assert.strictEqual(old.value, 1)
				hooks.close()
				assert.strictEqual(hooks.counts().sources, 0)
				assert.strictEqual(hooks.counts().edges, 0)
			}).pipe(run),
	)

	it.live("preserves the old resolution view during activation cleanup", () =>
		Effect.gen(function* () {
			const { hmr, fs, directory, write, load, reach } = yield* setup
			const entered = yield* Deferred.make<void>()
			const imported = yield* Deferred.make<number>()
			const release = Promise.withResolvers<void>()
			const key = `graft-hmr-cleanup:${directory}`
			const keySource = yield* quote(key)
			const runtime = yield* quote(runtimeUrl.href)
			const effect = yield* quote(effectUrl)
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					Reflect.set(globalThis, key, {
						enter: () => Deferred.doneUnsafe(entered, Exit.void),
						release: release.promise,
						imported: (value: number) =>
							Deferred.doneUnsafe(imported, Exit.succeed(value)),
					})
				}),
				() =>
					Effect.sync(() => {
						release.resolve()
						Reflect.deleteProperty(globalThis, key)
					}),
			)
			yield* write("dependency.mjs", "export const value = 1")
			yield* write(
				"a.mjs",
				`import {Plugin} from ${runtime}; import {Effect} from ${effect}; import {value} from './dependency.mjs'; const gate=globalThis[${keySource}]; export default Plugin.make({name:'cleanup-'+value, apply: () => Effect.addFinalizer(() => Effect.promise(async () => {gate.enter(); await gate.release; const old = await import('./dependency.mjs'); gate.imported(old.value)}))});`,
			)
			const plugin = yield* load("./a.mjs")
			const fork = yield* Graft.plugin(plugin)
			yield* fork.await
			const { changed } = yield* watchEvents(hmr, directory, fs)
			yield* write("dependency.mjs", "export const value = 2")
			const result = yield* changed("dependency.mjs")
			assert.strictEqual(result._tag, "Reloaded")
			yield* Deferred.await(entered)
			release.resolve()
			const value = yield* Deferred.await(imported)
			assert.strictEqual(value, 1)
			yield* reach(["cleanup-2"])
		}).pipe(run),
	)

	it.live(
		"retains edits arriving while an incremental candidate import is suspended",
		() =>
			Effect.gen(function* () {
				const { hmr, fs, directory, write, entry, load } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				for (const name of ["a", "b"]) {
					yield* write(`${name}.mjs`, entry(name))
					yield* load(`./${name}.mjs`)
				}
				const entered = yield* Deferred.make<void>()
				const release = Promise.withResolvers<void>()
				const key = `graft-hmr-events:${directory}`
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
				const { events, results } = yield* watchEvents(hmr, directory, fs)
				yield* write(
					"a.mjs",
					`const gate=globalThis[${keySource}]; gate.enter(); await gate.release; ${entry("edited-a")}`,
				)
				yield* Queue.offer(events, { _tag: "Update", path: "a.mjs" })
				yield* Deferred.await(entered)
				yield* write("b.mjs", entry("edited-b"))
				yield* Queue.offer(events, { _tag: "Update", path: "b.mjs" })
				release.resolve()
				const first = yield* Queue.take(results)
				const second = yield* Queue.take(results)
				assert(first._tag === "Reloaded" && second._tag === "Reloaded")
				assert.strictEqual(first.entries.length, 1)
				assert.strictEqual(second.entries.length, 1)
				const a = yield* load("./a.mjs")
				const b = yield* load("./b.mjs")
				assert.strictEqual(a.name, "edited-a-1")
				assert.strictEqual(b.name, "edited-b-1")
			}).pipe(run),
	)

	it.effect(
		"allows a reload to complete while a filesystem snapshot is in flight",
		() =>
			Effect.gen(function* () {
				const { hmr, fs, directory, write, entry, load } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", entry("a"))
				yield* load("./a.mjs")
				const reloaded = yield* Deferred.make<void>()
				const ready = yield* Deferred.make<void>()
				const armed = yield* Ref.make(true)
				const results = yield* Ref.make(0)
				yield* write("dependency.mjs", "export const value = 2")
				yield* hmr.watch([directory], { debounce: 0 }).pipe(
					Stream.runForEach(() => Ref.update(results, (n) => n + 1)),
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
															? hmr.reload.pipe(
																	Effect.orDie,
																	Effect.andThen(
																		Deferred.succeed(reloaded, undefined),
																	),
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
				yield* Deferred.await(reloaded)
				yield* TestClock.adjust("1 second")
				const count = yield* Ref.get(results)
				assert.strictEqual(count, 0)
				const current = yield* load("./a.mjs")
				assert.strictEqual(current.name, "a-2")
			}).pipe(run),
	)

	it.live(
		"preserves a leased failed import when an unrelated lease closes",
		() =>
			Effect.gen(function* () {
				const { hmr, write, entry } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write("a.mjs", "throw new Error('Initial import failed')")
				const failed = yield* Effect.exit(hmr.importerScoped("./a.mjs"))
				assert(Exit.isFailure(failed))
				yield* write("b.mjs", entry("b"))
				yield* hmr.importerScoped("./b.mjs").pipe(Effect.scoped)
				yield* write("a.mjs", entry("fixed"))
				const cached = yield* Effect.exit(hmr.importerScoped("./a.mjs"))
				assert(Exit.isFailure(cached))
				yield* hmr.reload
				const recovered = yield* hmr.importerScoped("./a.mjs")
				assert(Option.isSome(Plugin.fromModule(recovered)))
			}).pipe(run),
	)

	it.live(
		"checks native capabilities acquired through a reused dependency before publication",
		() =>
			Effect.gen(function* () {
				const { hmr, fs, directory, write, entry, load, reach } = yield* setup
				yield* write(
					"dependency.mjs",
					"export const value = 1; export const native = () => import('node:module')",
				)
				yield* write("a.mjs", entry("a"))
				const plugin = yield* load("./a.mjs")
				const fork = yield* Graft.plugin(plugin)
				yield* fork.await
				const { changed } = yield* watchEvents(hmr, directory, fs)
				yield* write(
					"a.mjs",
					`import {native} from './dependency.mjs'; await native(); ${entry("new")}`,
				)
				const result = yield* changed("a.mjs")
				assert(result._tag === "Skipped")
				assert.strictEqual(result.reason, "restart-required")
				yield* reach(["a-1"])
			}).pipe(run),
	)

	it.live(
		"does not throw a candidate restart error into concurrent old module code",
		() =>
			Effect.gen(function* () {
				const { hmr, fs, directory, write, entry } = yield* setup
				yield* write("dependency.mjs", "export const value = 1")
				yield* write(
					"a.mjs",
					`${entry("a")}; export const native = () => import('node:module')`,
				)
				const original = yield* hmr.importerScoped("./a.mjs")
				assert(
					Predicate.hasProperty(original, "native") &&
						typeof original.native === "function",
				)
				const native = original.native as () => Promise<unknown>
				const entered = yield* Deferred.make<void>()
				const release = Promise.withResolvers<void>()
				const key = `graft-hmr-native:${directory}`
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
				const { events, results } = yield* watchEvents(hmr, directory, fs)
				yield* write(
					"a.mjs",
					`const gate=globalThis[${keySource}]; gate.enter(); await gate.release; ${entry("new")}`,
				)
				yield* Queue.offer(events, { _tag: "Update", path: "a.mjs" })
				yield* Deferred.await(entered)
				yield* Effect.promise(native)
				release.resolve()
				const result = yield* Queue.take(results)
				assert.strictEqual(result._tag, "Reloaded")
			}).pipe(run),
	)

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
				const stats = yield* Ref.make(0)
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
						stat: (path) =>
							fs
								.stat(path)
								.pipe(
									Effect.tap(() =>
										HashMap.has(contents, path)
											? Ref.update(stats, (n) => n + 1)
											: Effect.void,
									),
								),
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
				// The poller may start its first sleep after `ready`. Advance until a
				// second scan has stat'ed both files: scans run one after another, so
				// the first scan's result, if any, is already in the queue.
				yield* TestClock.adjust("1 second").pipe(
					Effect.andThen(Ref.get(stats)),
					Effect.repeat({ until: (n) => n >= 4 }),
				)
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
