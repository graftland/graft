import { assert, describe, it } from "@effect/vitest"
import { WatchResult } from "@graftland/hmr"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Logger,
	Queue,
	Ref,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { isModule, watchModules } from "../src/internal/watch.ts"

const logging = Effect.gen(function* () {
	const logged = yield* Queue.unbounded<Logger.Options<unknown>>()
	const layer = Logger.layer([
		Logger.make((options) => {
			Queue.offerUnsafe(logged, options)
		}),
	])
	return { logged, layer }
})

describe("module watching", () => {
	it("ignores dependency directories but accepts names that merely contain node_modules", () => {
		assert.isFalse(isModule("/app/node_modules/plugin/index.ts"))
		assert.isFalse(isModule("C:\\app\\node_modules\\plugin\\index.ts"))
		assert.isTrue(isModule("/app/node_modules-helper.ts"))
		assert.isTrue(isModule("/app/without_node_modules/plugin.mjs"))
		assert.isFalse(isModule("/app/graft.yml"))
	})

	it.effect(
		"reports conflicting replacement identities and still retries loader entries",
		() =>
			Effect.gen(function* () {
				const { logged, layer } = yield* logging
				const retried = yield* Deferred.make<void>()
				const hmr = {
					watch: () =>
						Stream.make(
							WatchResult.Skipped({
								reason: "identity-conflict",
								modules: ["file:///app/a.mjs", "file:///app/b.mjs"],
							}),
						),
				}
				const watching = yield* watchModules(
					hmr,
					"/app",
					Deferred.succeed(retried, undefined).pipe(Effect.asVoid),
				).pipe(Effect.provide(layer), Effect.forkScoped)
				yield* Deferred.await(retried)
				const entry = yield* Queue.take(logged)
				assert.strictEqual(entry.logLevel, "Warn")
				assert.deepStrictEqual(entry.message, [
					"Restart required: plugin replacement identities conflict in file:///app/a.mjs, file:///app/b.mjs",
				])
				yield* Fiber.interrupt(watching)
			}).pipe(Effect.scoped, Effect.provide(FileSystem.layerNoop({}))),
	)

	it.effect(
		"uses the HMR filter, retries after reload, and preserves failures without stopping",
		() =>
			Effect.gen(function* () {
				const { logged, layer } = yield* logging
				const results = yield* Queue.unbounded<WatchResult>()
				const attempts = yield* Ref.make(0)
				const retried = yield* Deferred.make<void>()
				const importDefect = new Error("Module evaluation failed")
				const retryDefect = new Error("Retry failed")
				const importCause = Cause.combine(
					Cause.die(importDefect),
					Cause.die(new Error("Import cleanup failed")),
				)
				const hmr = {
					watch: (
						paths: ReadonlyArray<string>,
						options?: import("@graftland/hmr").WatchOptions,
					) => {
						assert.deepStrictEqual(paths, ["/app"])
						assert.strictEqual(options?.recursive, true)
						assert.strictEqual(options?.filter, isModule)
						return Stream.fromQueue(results)
					},
				}
				const retry = Effect.gen(function* () {
					const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
					if (n === 1) return yield* Effect.die(retryDefect)
					yield* Deferred.succeed(retried, undefined)
				})
				const watching = yield* watchModules(hmr, "/app", retry).pipe(
					Effect.provide(layer),
					Effect.forkScoped,
				)
				yield* Queue.offerAll(results, [
					WatchResult.Failed({ cause: importCause }),
					WatchResult.Reloaded({ entries: ["file:///app/plugin.mjs"] }),
					WatchResult.Reloaded({ entries: ["file:///app/plugin.mjs"] }),
				])
				yield* Deferred.await(retried)
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 2)
				const logs = yield* Queue.takeAll(logged)
				const errors = Array.filter(logs, (entry) => entry.logLevel === "Error")
				assert.strictEqual(errors.length, 2)
				const [importLog, retryLog] = errors
				assert(importLog !== undefined)
				assert(retryLog !== undefined)
				assert.deepStrictEqual(importLog.cause, importCause)
				assert.strictEqual(Cause.squash(retryLog.cause), retryDefect)
				yield* Fiber.interrupt(watching)
			}).pipe(Effect.scoped, Effect.provide(FileSystem.layerNoop({}))),
	)

	it.effect.each([false, true])(
		"observes watcher shutdown without dropping cleanup defects (defect: %s)",
		(defect) =>
			Effect.gen(function* () {
				const { logged, layer } = yield* logging
				const ready = yield* Deferred.make<void>()
				const marker = new Error("Watcher cleanup failed")
				const hmr = {
					watch: () =>
						Stream.fromEffect(
							Deferred.succeed(ready, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(defect ? Effect.die(marker) : Effect.void),
							),
						),
				}
				const watcher = yield* Effect.scoped(
					Effect.gen(function* () {
						const fiber = yield* watchModules(hmr, "/app", Effect.void).pipe(
							Effect.forkScoped,
						)
						yield* Deferred.await(ready)
						return fiber
					}),
				).pipe(Effect.provide(layer))
				const exit = yield* Fiber.await(watcher)
				assert(Exit.isFailure(exit))
				assert(Cause.hasInterrupts(exit.cause))
				const count = yield* Queue.size(logged)
				const logs = count > 0 ? yield* Queue.takeAll(logged) : []
				assert.strictEqual(logs.length, defect ? 1 : 0)
				if (defect) {
					assert.deepStrictEqual(logs[0]?.cause, exit.cause)
					assert.include(Cause.pretty(exit.cause), marker.message)
				}
			}).pipe(Effect.provide(FileSystem.layerNoop({}))),
	)

	it.effect("logs the original backend cause and reinstalls the watcher", () =>
		Effect.gen(function* () {
			const { logged, layer } = yield* logging
			const attempts = yield* Ref.make(0)
			const restarted = yield* Deferred.make<void>()
			const defect = new Error("Watcher backend failed")
			const hmr = {
				watch: () =>
					Stream.unwrap(
						Effect.gen(function* () {
							const count = yield* Ref.updateAndGet(attempts, (n) => n + 1)
							if (count === 1) return Stream.die(defect)
							yield* Deferred.succeed(restarted, undefined)
							return Stream.never
						}),
					),
			}
			const watching = yield* watchModules(hmr, "/app", Effect.void).pipe(
				Effect.provide(layer),
				Effect.forkScoped,
			)
			const log = yield* Queue.take(logged)
			assert.strictEqual(Cause.squash(log.cause), defect)
			yield* TestClock.adjust("1 second")
			yield* Deferred.await(restarted)
			yield* Fiber.interrupt(watching)
			const count = yield* Ref.get(attempts)
			assert.strictEqual(count, 2)
		}).pipe(Effect.scoped, Effect.provide(FileSystem.layerNoop({}))),
	)
})
