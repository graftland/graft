// Native loading exercises the same HMR hooks as the CLI process.
import { createRequire } from "node:module"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Logger,
	Option,
	Path,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
	String,
} from "effect"

const runtimeUrl = new URL("../.cache/integration/runtime.mjs", import.meta.url)
const { Hmr, Graft, ModuleResolver, watchModules } = createRequire(
	import.meta.url,
)(runtimeUrl.pathname) as typeof import("./runtime.ts")
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

it.live(
	"retains failed module observations after candidate resource cleanup",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const temporary = yield* fs.makeTempDirectoryScoped()
			const directory = yield* fs.realPath(temporary)
			const base = (yield* path.toFileUrl(`${directory}/app.mjs`)).href
			const hmr = yield* Hmr.make({
				base,
				include: String.startsWith(new URL(".", base).href),
			})
			const resources = yield* Ref.make(0)
			const parent = yield* Effect.scope
			const owner = yield* Scope.fork(parent)
			const resolver = yield* ModuleResolver.make({
				base: directory,
				importer: (specifier, options) =>
					Effect.acquireRelease(
						Ref.update(resources, (count) => count + 1),
						() => Ref.update(resources, (count) => count - 1),
					).pipe(Effect.andThen(hmr.importerScoped(specifier, options))),
			})
			yield* fs.writeFileString(`${directory}/plugin.mjs`, "export default ???")
			const failed = yield* Effect.exit(
				resolver.resolve("./plugin.mjs").pipe(Scope.provide(owner)),
			)
			assert(Exit.isFailure(failed))
			const released = yield* Ref.get(resources)
			assert.strictEqual(released, 0)
			const runtime = yield* quote(
				new URL("../.cache/integration/plugin.mjs", import.meta.url).href,
			)
			const effect = yield* quote(import.meta.resolve("effect"))
			yield* fs.writeFileString(
				`${directory}/plugin.mjs`,
				`import { Plugin } from ${runtime}; import { Effect } from ${effect}; export default Plugin.make({ name: 'recovered', apply: () => Effect.void });`,
			)
			const changed = yield* hmr.watch([directory], { debounce: 0 }).pipe(
				Stream.runHead,
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					watch: () => Stream.never,
				}),
				Effect.timeout("2 seconds"),
			)
			assert.strictEqual(Option.getOrThrow(changed)._tag, "Reloaded")
			yield* Scope.close(owner, Exit.void)
			const recovered = yield* resolver.resolve("./plugin.mjs")
			assert.strictEqual(recovered.name, "recovered")
		}).pipe(Effect.scoped, Effect.provide([Graft.layer, NodeServices.layer])),
)

it.effect.each(["effect", "scope", "clean"])(
	"observes real HMR watcher cleanup exactly once (%s)",
	(kind) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const path = yield* Path.Path
			const hmr = yield* Hmr.make({
				base: (yield* path.toFileUrl(`${directory}/app.mjs`)).href,
			})
			const ready = yield* Deferred.make<void>()
			const logs = yield* Queue.unbounded<Cause.Cause<unknown>>()
			const marker = new Error("Watcher cleanup failed")
			const source =
				kind === "effect"
					? Stream.fromEffect(
							Deferred.succeed(ready, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die(marker)),
							),
						)
					: Stream.unwrap(
							Effect.addFinalizer(() =>
								kind === "clean" ? Effect.void : Effect.die(marker),
							).pipe(
								Effect.andThen(Deferred.succeed(ready, undefined)),
								Effect.as(Stream.never),
							),
						)
			const watcher = yield* watchModules(hmr, directory, Effect.void).pipe(
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					watch: () => source,
				}),
				Effect.provide(
					Logger.layer([
						Logger.make((entry) => {
							Queue.offerUnsafe(logs, entry.cause)
						}),
					]),
				),
				Effect.forkScoped,
			)
			yield* Deferred.await(ready)
			yield* Fiber.interrupt(watcher)
			const count = yield* Queue.size(logs)
			const causes = count > 0 ? yield* Queue.takeAll(logs) : []
			assert.strictEqual(causes.length, kind === "clean" ? 0 : 1)
			if (kind === "clean") return
			const cause = Option.getOrThrow(Array.head(causes))
			assert(Cause.hasInterrupts(cause))
			assert(
				Array.some(
					cause.reasons,
					(reason) => Cause.isDieReason(reason) && reason.defect === marker,
				),
			)
		}).pipe(Effect.scoped, Effect.provide([Graft.layer, NodeServices.layer])),
)

it.effect("forwards a real backend failure once with its complete cause", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped()
		const path = yield* Path.Path
		const hmr = yield* Hmr.make({
			base: (yield* path.toFileUrl(`${directory}/app.mjs`)).href,
		})
		const logs = yield* Queue.unbounded<Cause.Cause<unknown>>()
		const cause = Cause.combine(
			Cause.die(new Error("Backend failed")),
			Cause.die(new Error("Backend cleanup failed")),
		)
		const watcher = yield* watchModules(hmr, directory, Effect.void).pipe(
			Effect.provideService(FileSystem.FileSystem, {
				...fs,
				watch: () => Stream.failCause(cause),
			}),
			Effect.provide(
				Logger.layer([
					Logger.make((entry) => {
						Queue.offerUnsafe(logs, entry.cause)
					}),
				]),
			),
			Effect.forkScoped,
		)
		const logged = yield* Queue.take(logs)
		assert.deepStrictEqual(logged, cause)
		yield* Fiber.interrupt(watcher)
		const remaining = yield* Queue.size(logs)
		assert.strictEqual(remaining, 0)
	}).pipe(Effect.scoped, Effect.provide([Graft.layer, NodeServices.layer])),
)
