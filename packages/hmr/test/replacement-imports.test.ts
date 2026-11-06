import { createRequire } from "node:module"

import {
	Array,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Path,
	Predicate,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
	String,
} from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import type { Graft as GraftType, Plugin as PluginType } from "@graftland/graft"

const runtimeUrl = new URL("../.cache/integration/runtime.mjs", import.meta.url)
const { Hmr, Graft } = createRequire(import.meta.url)(
	runtimeUrl.pathname,
) as typeof import("./runtime.ts")
const effectUrl = import.meta.resolve("effect")
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		GraftType.Graft | Scope.Scope | FileSystem.FileSystem | Path.Path
	>,
) =>
	effect.pipe(
		Effect.provide(Graft.layer),
		Effect.provide([NodeFileSystem.layer, Path.layer]),
		Effect.scoped,
	)

it.live(
	"allows a replacement activation to use the same HMR session for imports",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const temporary = yield* fs.makeTempDirectoryScoped()
			const directory = yield* fs.realPath(temporary)
			const base = new URL(`file://${directory}/app.mjs`).href
			const hmr = yield* Hmr.make({
				base,
				include: String.startsWith(new URL(".", base).href),
				activationTimeout: "100 millis",
			})
			const key = `hmr-replacement-import:${directory}`
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					Reflect.set(globalThis, key, () => hmr.importModule("./helper.mjs")),
				),
				() =>
					Effect.sync(() => {
						Reflect.deleteProperty(globalThis, key)
					}),
			)
			const runtimeSource = yield* quote(runtimeUrl.href)
			const effectSource = yield* quote(effectUrl)
			const keySource = yield* quote(key)
			const source = (version: number) => `
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
export default Plugin.make({
  name: 'parent-${version}',
  apply: () => ${version} === 1 ? Effect.void : Effect.asVoid(globalThis[${keySource}]()),
});
`
			yield* fs.writeFileString(
				`${directory}/helper.mjs`,
				"export const value = 42",
			)
			yield* fs.writeFileString(`${directory}/parent.mjs`, source(1))
			const namespace = yield* Effect.promise(() =>
				hmr.importer("./parent.mjs"),
			)
			assert(Predicate.hasProperty(namespace, "default"))
			const fork = yield* Graft.plugin(
				namespace.default as PluginType.Plugin<void, void, never>,
			)
			yield* fork.await
			yield* fs.writeFileString(`${directory}/parent.mjs`, source(2))
			const result = yield* hmr.reload
			assert.strictEqual(result._tag, "Reloaded")
		}).pipe(run),
)

it.live(
	"keeps old import identity and retries dirty entries after an unrelated watch event",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const temporary = yield* fs.makeTempDirectoryScoped()
			const directory = yield* fs.realPath(temporary)
			const base = new URL(`file://${directory}/app.mjs`).href
			const hmr = yield* Hmr.make({
				base,
				include: String.startsWith(new URL(".", base).href),
			})
			const allowed = yield* Ref.make(false)
			const key = `hmr-replacement-dirty:${directory}`
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					Reflect.set(globalThis, key, () =>
						Ref.get(allowed).pipe(
							Effect.flatMap((allowed) =>
								allowed ? Effect.void : Effect.fail("broken"),
							),
						),
					),
				),
				() =>
					Effect.sync(() => {
						Reflect.deleteProperty(globalThis, key)
					}),
			)
			const runtimeSource = yield* quote(runtimeUrl.href)
			const effectSource = yield* quote(effectUrl)
			const keySource = yield* quote(key)
			const source = (name: string, version: number, fails: boolean) => `
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
export default Plugin.make({ name: '${name}-${version}', apply: () => ${fails ? `globalThis[${keySource}]()` : "Effect.void"} });
`
			yield* fs.writeFileString(`${directory}/a.mjs`, source("a", 1, false))
			yield* fs.writeFileString(`${directory}/b.mjs`, source("b", 1, false))
			const original = yield* Effect.promise(() => hmr.importer("./a.mjs"))
			assert(Predicate.hasProperty(original, "default"))
			const second = yield* Effect.promise(() => hmr.importer("./b.mjs"))
			assert(Predicate.hasProperty(second, "default"))
			const a = yield* Graft.plugin(
				original.default as PluginType.Plugin<void, void, never>,
			)
			const b = yield* Graft.plugin(
				second.default as PluginType.Plugin<void, void, never>,
			)
			yield* a.await
			yield* b.await
			const events = yield* Queue.unbounded<FileSystem.WatchEvent>()
			const results =
				yield* Queue.unbounded<import("../src/index.ts").WatchResult>()
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
			yield* fs.writeFileString(`${directory}/a.mjs`, source("a", 2, true))
			yield* Queue.offer(events, { _tag: "Update", path: "a.mjs" })
			const failed = yield* Queue.take(results)
			assert.strictEqual(failed._tag, "RolledBack")
			const retained = yield* Effect.promise(() => hmr.importer("./a.mjs"))
			assert(Predicate.hasProperty(retained, "default"))
			assert.strictEqual(retained.default, original.default)
			yield* Ref.set(allowed, true)
			yield* fs.writeFileString(`${directory}/b.mjs`, source("b", 2, false))
			yield* Queue.offer(events, { _tag: "Update", path: "b.mjs" })
			const retried = yield* Queue.take(results)
			assert.strictEqual(retried._tag, "Reloaded")
			if (retried._tag === "Reloaded")
				assert.deepStrictEqual(Array.sort(retried.entries, String.Order), [
					new URL("a.mjs", base).href,
					new URL("b.mjs", base).href,
				])
		}).pipe(run),
)

it.live("stays in step with the forks after a reload is interrupted", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const temporary = yield* fs.makeTempDirectoryScoped()
		const directory = yield* fs.realPath(temporary)
		const base = new URL(`file://${directory}/app.mjs`).href
		const hmr = yield* Hmr.make({
			base,
			include: String.startsWith(new URL(".", base).href),
		})
		const gate = yield* Deferred.make<void>()
		const key = `hmr-interrupted-reload:${directory}`
		yield* Effect.acquireRelease(
			Effect.sync(() => Reflect.set(globalThis, key, Deferred.await(gate))),
			() =>
				Effect.sync(() => {
					Reflect.deleteProperty(globalThis, key)
				}),
		)
		const runtimeSource = yield* quote(runtimeUrl.href)
		const effectSource = yield* quote(effectUrl)
		const keySource = yield* quote(key)
		// Version 2 waits for the gate while it starts.
		const source = (version: number) => `
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
export default Plugin.make({
  name: 'a-${version}',
  apply: () => ${version} === 2 ? globalThis[${keySource}] : Effect.void,
});
`
		yield* fs.writeFileString(`${directory}/a.mjs`, source(1))
		const namespace = yield* Effect.promise(() => hmr.importer("./a.mjs"))
		assert(Predicate.hasProperty(namespace, "default"))
		const fork = yield* Graft.plugin(
			namespace.default as PluginType.Plugin<void, void, never>,
		)
		yield* fork.await
		yield* fs.writeFileString(`${directory}/a.mjs`, source(2))
		const reloading = yield* Effect.forkChild(hmr.reload)
		yield* Graft.forks.pipe(
			Stream.filter((forks) => forks[0]?.name === "a-2"),
			Stream.runHead,
		)
		yield* Fiber.interrupt(reloading)
		yield* Deferred.succeed(gate, undefined)
		yield* fs.writeFileString(`${directory}/a.mjs`, source(3))
		const next = yield* hmr.reload
		assert.strictEqual(next._tag, "Reloaded")
		const settled = yield* Graft.forks.pipe(
			Stream.filter((forks) => forks[0]?.name === "a-3"),
			Stream.runHead,
		)
		assert.isTrue(settled._tag === "Some")
	}).pipe(run),
)

it.live(
	"keeps track of the running plugin when an import during a failed reload sees the new one",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const temporary = yield* fs.makeTempDirectoryScoped()
			const directory = yield* fs.realPath(temporary)
			const base = new URL(`file://${directory}/app.mjs`).href
			const hmr = yield* Hmr.make({
				base,
				include: String.startsWith(new URL(".", base).href),
			})
			const entered = yield* Deferred.make<void>()
			const gate = yield* Deferred.make<void>()
			const key = `hmr-import-during-rollback:${directory}`
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					Reflect.set(
						globalThis,
						key,
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(gate)),
							Effect.andThen(Effect.fail("broken")),
						),
					),
				),
				() =>
					Effect.sync(() => {
						Reflect.deleteProperty(globalThis, key)
					}),
			)
			const runtimeSource = yield* quote(runtimeUrl.href)
			const effectSource = yield* quote(effectUrl)
			const keySource = yield* quote(key)
			// Version 2 fails once the gate opens.
			const source = (version: number) => `
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
export default Plugin.make({
  name: 'a-${version}',
  apply: () => ${version} === 2 ? globalThis[${keySource}] : Effect.void,
});
`
			yield* fs.writeFileString(`${directory}/a.mjs`, source(1))
			const namespace = yield* Effect.promise(() => hmr.importer("./a.mjs"))
			assert(Predicate.hasProperty(namespace, "default"))
			const fork = yield* Graft.plugin(
				namespace.default as PluginType.Plugin<void, void, never>,
			)
			yield* fork.await
			yield* fs.writeFileString(`${directory}/a.mjs`, source(2))
			const reloading = yield* Effect.forkChild(hmr.reload)
			yield* Deferred.await(entered)
			// Another caller imports the entry while the new version starts.
			yield* Effect.promise(() => hmr.importer("./a.mjs"))
			yield* Deferred.succeed(gate, undefined)
			const failed = yield* Fiber.join(reloading)
			assert.strictEqual(failed._tag, "RolledBack")
			yield* fs.writeFileString(`${directory}/a.mjs`, source(3))
			const next = yield* hmr.reload
			assert.strictEqual(next._tag, "Reloaded")
			const settled = yield* Graft.forks.pipe(
				Stream.filter((forks) => forks[0]?.name === "a-3"),
				Stream.runHead,
			)
			assert.isTrue(settled._tag === "Some")
		}).pipe(run),
)

for (const shared of [false, true]) {
	it.live(
		`does not resurrect leases released during replacement (shared: ${shared})`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const temporary = yield* fs.makeTempDirectoryScoped()
				const directory = yield* fs.realPath(temporary)
				const base = new URL(`file://${directory}/app.mjs`).href
				const hmr = yield* Hmr.make({
					base,
					include: String.startsWith(new URL(".", base).href),
				})
				const entered = yield* Deferred.make<void>()
				const gate = yield* Deferred.make<void>()
				const key = `hmr-released-lease:${directory}`
				yield* Effect.acquireRelease(
					Effect.sync(() =>
						Reflect.set(
							globalThis,
							key,
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(gate)),
							),
						),
					),
					() =>
						Effect.sync(() => {
							Reflect.deleteProperty(globalThis, key)
						}),
				)
				const runtimeSource = yield* quote(runtimeUrl.href)
				const effectSource = yield* quote(effectUrl)
				const keySource = yield* quote(key)
				const source = (version: number) => `
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
export default Plugin.make({
 name: 'leased-${version}',
 apply: () => ${version} === 2 ? globalThis[${keySource}] : Effect.void,
});
`
				yield* fs.writeFileString(`${directory}/leased.mjs`, source(1))
				const first = yield* Scope.make()
				const second = yield* Scope.make()
				yield* Effect.addFinalizer(() => Scope.close(first, Exit.void))
				yield* Effect.addFinalizer(() => Scope.close(second, Exit.void))
				const namespace = yield* hmr
					.importerScoped("./leased.mjs")
					.pipe(Effect.provideService(Scope.Scope, first))
				if (shared)
					yield* hmr
						.importerScoped("./leased.mjs")
						.pipe(Effect.provideService(Scope.Scope, second))
				assert(Predicate.hasProperty(namespace, "default"))
				const fork = yield* Graft.plugin(
					namespace.default as PluginType.Plugin<void, void, never>,
				)
				yield* fork.await
				yield* fs.writeFileString(`${directory}/leased.mjs`, source(2))
				const reloading = yield* Effect.forkChild(hmr.reload)
				yield* Deferred.await(entered)
				yield* Scope.close(first, Exit.void)
				yield* Deferred.succeed(gate, undefined)
				const result = yield* Fiber.join(reloading)
				assert.strictEqual(result._tag, "Reloaded")
				yield* Scope.close(second, Exit.void)
				// A released entry must not be imported by a later reload, even if now invalid.
				yield* fs.writeFileString(
					`${directory}/leased.mjs`,
					"invalid JavaScript !",
				)
				const next = yield* hmr.reload
				assert.strictEqual(next._tag, "Reloaded")
				if (next._tag === "Reloaded") assert.deepStrictEqual(next.entries, [])
			}).pipe(run),
	)
}
