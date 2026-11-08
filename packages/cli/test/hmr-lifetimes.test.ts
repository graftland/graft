// Native loading exercises the same HMR hooks as the CLI process.
import { createRequire } from "node:module"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Logger,
	Option,
	Path,
	Queue,
	Stream,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import type * as Runtime from "./runtime"

const runtimeUrl = new URL("../.cache/integration/runtime.mjs", import.meta.url)
const { Hmr, Graft, watchModules }: typeof Runtime = createRequire(
	import.meta.url,
)(runtimeUrl.pathname)

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
