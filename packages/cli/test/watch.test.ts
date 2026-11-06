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
	References,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import { WatchResult } from "@graftland/hmr"

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
		"warns once per plugin that failed to start, with its cause and identity",
		() =>
			Effect.gen(function* () {
				// Annotations belong to the fiber at the time of the log call.
				const logged = yield* Queue.unbounded<{
					readonly level: string
					readonly message: unknown
					readonly cause: Cause.Cause<unknown>
					readonly annotations: Readonly<Record<string, unknown>>
				}>()
				const layer = Logger.layer([
					Logger.make((options) => {
						Queue.offerUnsafe(logged, {
							level: options.logLevel,
							message: options.message,
							cause: options.cause,
							annotations: options.fiber.getRef(
								References.CurrentLogAnnotations,
							),
						})
					}),
				])
				const retried = yield* Deferred.make<void>()
				const cause = Cause.fail("broken")
				const hmr = {
					watch: () =>
						Stream.make(
							WatchResult.RolledBack({
								entries: ["file:///app/a.mjs"],
								failures: [
									Graft.ReplacementFailure.Failed({
										fork: 7,
										plugin: "a",
										cause,
									}),
									Graft.ReplacementFailure.TimedOut({ fork: 8, plugin: "b" }),
								],
							}),
						),
				}
				const watching = yield* watchModules(
					hmr,
					"/app",
					Deferred.succeed(retried, undefined).pipe(Effect.asVoid),
				).pipe(Effect.provide(layer), Effect.forkScoped)
				yield* Deferred.await(retried)
				const failed = yield* Queue.take(logged)
				const late = yield* Queue.take(logged)
				assert.deepStrictEqual(
					[failed.level, failed.message, late.level, late.message],
					[
						"Warn",
						['Kept the previous code: plugin "a" failed to start'],
						"Warn",
						['Kept the previous code: plugin "b" did not start in time'],
					],
				)
				assert.isTrue(Cause.hasFails(failed.cause))
				assert.deepStrictEqual(late.cause, Cause.empty)
				assert.deepInclude(late.annotations, {
					"graft.fork": 8,
					"graft.plugin": "b",
				})
				assert.deepInclude(failed.annotations, {
					"graft.fork": 7,
					"graft.plugin": "a",
				})
				yield* Fiber.interrupt(watching)
			}).pipe(Effect.scoped, Effect.provide(FileSystem.layerNoop({}))),
	)

	it.effect(
		"reports recovery failure as errors with both full causes and retries",
		() =>
			Effect.gen(function* () {
				const { logged, layer } = yield* logging
				const retried = yield* Deferred.make<void>()
				const replacement = Cause.combine(
					Cause.fail("replacement failed"),
					Cause.die("replacement defect"),
				)
				const recovery = Cause.combine(
					Cause.fail("recovery failed"),
					Cause.die("recovery defect"),
				)
				const hmr = {
					watch: () =>
						Stream.make(
							WatchResult.RecoveryFailed({
								entries: ["file:///app/a.mjs"],
								failures: [
									Graft.ReplacementFailure.Failed({
										fork: 7,
										plugin: "new",
										cause: replacement,
									}),
									Graft.ReplacementFailure.TimedOut({
										fork: 8,
										plugin: "slow",
									}),
								],
								recovery: [
									Graft.ReplacementFailure.Failed({
										fork: 7,
										plugin: "old",
										cause: recovery,
									}),
								],
							}),
						),
				}
				const watching = yield* watchModules(
					hmr,
					"/app",
					Deferred.succeed(retried, undefined).pipe(Effect.asVoid),
				).pipe(Effect.provide(layer), Effect.forkScoped)
				yield* Deferred.await(retried)
				const logs = yield* Queue.takeAll(logged)
				assert.deepStrictEqual(
					Array.map(logs, (log) => [log.logLevel, log.message, log.cause]),
					[
						[
							"Error",
							['Replacement abandoned: plugin "new" failed to start'],
							replacement,
						],
						[
							"Error",
							['Replacement abandoned: plugin "slow" did not start in time'],
							Cause.empty,
						],
						[
							"Error",
							['Previous code failed to restart: plugin "old" failed to start'],
							recovery,
						],
					],
				)
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

it.effect("logs interruption from the module watcher finalizer", () =>
	Effect.gen(function* () {
		const { logged, layer } = yield* logging
		const ready = yield* Deferred.make<void>()
		const source = Stream.unwrap(
			Effect.addFinalizer(() => Effect.interrupt).pipe(
				Effect.andThen(Deferred.succeed(ready, undefined)),
				Effect.as(Stream.never),
			),
		)
		yield* Effect.scoped(
			Effect.gen(function* () {
				yield* watchModules({ watch: () => source }, "/app", Effect.void).pipe(
					Effect.forkScoped,
				)
				yield* Deferred.await(ready)
			}),
		).pipe(Effect.provide([layer, FileSystem.layerNoop({})]))
		const logs = yield* Queue.takeAll(logged)
		assert.strictEqual(logs.length, 1)
		assert.isTrue(Cause.hasInterruptsOnly(logs[0]?.cause ?? Cause.empty))
	}),
)
