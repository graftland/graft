// Native require exercises the same Node module hooks used by the CLI.
import { createRequire } from "node:module"

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Logger,
	Option,
	Path,
	Predicate,
	Queue,
	Schema,
	Stream,
	String,
} from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import type { Plugin as PluginType } from "@graftland/graft"

const runtimeUrl = new URL("../.cache/integration/runtime.mjs", import.meta.url)
const { Graft, Hmr, watchModules } = createRequire(import.meta.url)(
	runtimeUrl.pathname,
) as typeof import("./runtime.ts")
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

it.live.each([false, true])(
	"reloads silently changed modules before retrying loader entries (saved before watch: %s)",
	(beforeWatch) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const temporary = yield* fs.makeTempDirectoryScoped()
			const directory = yield* fs.realPath(temporary)
			const base = yield* path.toFileUrl(`${directory}/app.mjs`)
			const hmr = yield* Hmr.make({
				base: base.href,
				include: String.startsWith(new URL(".", base).href),
			})
			const runtimeSource = yield* quote(runtimeUrl.href)
			const effectSource = yield* quote(import.meta.resolve("effect"))
			yield* fs.writeFileString(
				`${directory}/dependency.mjs`,
				"export const value = 1",
			)
			yield* fs.writeFileString(
				`${directory}/plugin.mjs`,
				`
import { Plugin } from ${runtimeSource};
import { Effect } from ${effectSource};
import { value } from './dependency.mjs';
export default Plugin.make({ name: 'plugin-' + value, apply: () => Effect.void });
`,
			)
			const namespace = yield* Effect.promise(() =>
				hmr.importer("./plugin.mjs"),
			)
			assert(Predicate.hasProperty(namespace, "default"))
			yield* Graft.plugin(
				namespace.default as PluginType.Plugin<void, void, never>,
			)
			const ready = yield* Deferred.make<void>()
			const retried = yield* Deferred.make<void>()
			const save = fs.writeFileString(
				`${directory}/dependency.mjs`,
				"export const value = 2",
			)
			if (beforeWatch) yield* save
			yield* watchModules(
				hmr,
				directory,
				Effect.gen(function* () {
					const current = yield* Effect.promise(() =>
						hmr.importer("./plugin.mjs"),
					)
					assert(Predicate.hasProperty(current, "default"))
					assert(Predicate.hasProperty(current.default, "name"))
					assert.strictEqual(current.default.name, "plugin-2")
					yield* Deferred.succeed(retried, undefined)
				}),
			).pipe(
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					// Install successfully but never notify, including for the completing save.
					watch: () =>
						Stream.callback(() =>
							Effect.sync(() => Deferred.doneUnsafe(ready, Exit.void)),
						),
				}),
				Effect.forkScoped,
			)
			yield* Deferred.await(ready)
			if (!beforeWatch) yield* save
			yield* Deferred.await(retried)
			const forks = yield* Graft.forks.pipe(
				Stream.filter((forks) => forks[0]?.name === "plugin-2"),
				Stream.runHead,
			)
			assert(Option.isSome(forks))
		}).pipe(
			Effect.provide(Graft.layer),
			Effect.provide([NodeFileSystem.layer, Path.layer]),
			Effect.scoped,
		),
)

it.live("observes a native import failure after watcher cancellation", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const temporary = yield* fs.makeTempDirectoryScoped()
		const directory = yield* fs.realPath(temporary)
		const base = yield* path.toFileUrl(`${directory}/app.mjs`)
		const hmr = yield* Hmr.make({
			base: base.href,
			include: String.startsWith(new URL(".", base).href),
		})
		const runtimeSource = yield* quote(runtimeUrl.href)
		const effectSource = yield* quote(import.meta.resolve("effect"))
		const source = `import { Plugin } from ${runtimeSource}; import { Effect } from ${effectSource};
export default Plugin.make({ name: 'plugin', apply: () => Effect.void });`
		yield* fs.writeFileString(`${directory}/plugin.mjs`, source)
		yield* Effect.promise(() => hmr.importer("./plugin.mjs"))
		const entered = yield* Deferred.make<void>()
		const ready = yield* Deferred.make<void>()
		const release = Promise.withResolvers<void>()
		const key = `graft-cancel:${directory}`
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
		const events = yield* Queue.unbounded<FileSystem.WatchEvent>()
		const logs = yield* Queue.unbounded<Cause.Cause<unknown>>()
		yield* Effect.gen(function* () {
			const watching = yield* watchModules(hmr, directory, Effect.void).pipe(
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					watch: () =>
						Stream.unwrap(
							Deferred.succeed(ready, undefined).pipe(
								Effect.as(Stream.fromQueue(events)),
							),
						),
				}),
				Effect.provide(
					Logger.layer([
						Logger.make((entry) => {
							Queue.offerUnsafe(logs, entry.cause)
						}),
					]),
				),
				Effect.forkChild,
			)
			yield* Deferred.await(ready)
			yield* fs.writeFileString(
				`${directory}/plugin.mjs`,
				`globalThis[${keySource}].enter();
await globalThis[${keySource}].release;
throw new Error('LATE_IMPORT_FAILURE');
${source}`,
			)
			yield* Queue.offer(events, { _tag: "Update", path: "plugin.mjs" })
			yield* Deferred.await(entered)
			const stopping = yield* Fiber.interrupt(watching).pipe(
				Effect.forkChild({ startImmediately: true }),
			)
			release.resolve()
			yield* Fiber.join(stopping)
			const count = yield* Queue.size(logs)
			assert.strictEqual(count, 1)
			const cause = yield* Queue.take(logs)
			const error = Option.getOrThrow(Cause.findErrorOption(cause))
			assert(Predicate.hasProperty(error, "stage"))
			assert.strictEqual(error.stage, "import")
			assert.include(Cause.pretty(cause), "LATE_IMPORT_FAILURE")
		}).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
	}).pipe(
		Effect.provide(Graft.layer),
		Effect.provide([NodeFileSystem.layer, Path.layer]),
		Effect.scoped,
	),
)
