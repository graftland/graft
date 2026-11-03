import { NodeServices } from "@effect/platform-node"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Config,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Logger,
	Path,
	Queue,
	Stream,
} from "effect"
import {
	EnvFile,
	layer as envLayer,
	watchEnvFile,
} from "../src/internal/env.ts"

const logging = Effect.gen(function* () {
	const logged = yield* Queue.unbounded<Logger.Options<unknown>>()
	const layer = Logger.layer([
		Logger.make((options) => {
			Queue.offerUnsafe(logged, options)
		}),
	])
	return { logged, layer }
})

describe("env file watching", () => {
	it.effect.each(["clean", "effect", "scope"] as const)(
		"keeps a defect the watch source raises while stopping (cleanup: %s)",
		(cleanup) =>
			Effect.gen(function* () {
				const { logged, layer } = yield* logging
				const ready = yield* Deferred.make<void>()
				const marker = new Error("Watcher cleanup failed")
				const source =
					cleanup === "effect"
						? Stream.fromEffect(
								Deferred.succeed(ready, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Effect.die(marker)),
								),
							)
						: Stream.unwrap(
								Effect.addFinalizer(() =>
									cleanup === "scope" ? Effect.die(marker) : Effect.void,
								).pipe(
									Effect.andThen(Deferred.succeed(ready, undefined)),
									Effect.as(Stream.never),
								),
							)
				const fs = FileSystem.layerNoop({ watch: () => source })
				const watcher = yield* Effect.scoped(
					Effect.gen(function* () {
						const fiber = yield* watchEnvFile(
							"/app/.env",
							Effect.succeed(false),
							Effect.void,
						).pipe(Effect.forkScoped)
						yield* Deferred.await(ready)
						return fiber
					}),
				).pipe(Effect.provide([layer, fs, Path.layer]))
				const exit = yield* Fiber.await(watcher)
				assert(Exit.isFailure(exit))
				const count = yield* Queue.size(logged)
				const logs = count > 0 ? yield* Queue.takeAll(logged) : []
				assert.strictEqual(logs.length, cleanup === "clean" ? 0 : 1)
				if (cleanup !== "clean") {
					const cause = logs[0]?.cause ?? Cause.empty
					assert(Cause.hasInterrupts(cause))
					assert(
						Array.some(
							cause.reasons,
							(reason) => Cause.isDieReason(reason) && reason.defect === marker,
						),
					)
				}
			}),
	)
})

it.effect(
	"reconciles symlink targets without native events and retains values after read failures",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const outside = yield* fs.makeTempDirectoryScoped()
			const request = `${directory}/.env`
			const one = `${outside}/one.env`
			const two = `${outside}/two.env`
			const write = (file: string, value: string) =>
				fs.writeFileString(file, `GRAFT_ENV_POLL_VALUE=${value}\n`)
			yield* write(one, "one")
			yield* fs.symlink(one, request)
			const { logged, layer } = yield* logging
			yield* Effect.gen(function* () {
				const { reload } = yield* EnvFile
				const checked = yield* Queue.unbounded<void>()
				const updates = yield* Queue.unbounded<string>()
				const value = Config.NonEmptyString("GRAFT_ENV_POLL_VALUE")
				yield* watchEnvFile(
					request,
					reload.pipe(Effect.onExit(() => Queue.offer(checked, undefined))),
					value.pipe(
						Effect.flatMap((value) => Queue.offer(updates, value)),
						Effect.asVoid,
					),
				).pipe(Effect.forkScoped)
				const poll = TestClock.adjust("1100 millis").pipe(
					Effect.andThen(Queue.take(checked)),
				)

				yield* write(request, "two")
				yield* poll
				const updated = yield* Queue.take(updates)
				assert.strictEqual(updated, "two")
				// Equal bytes at a different target do not retry unchanged entries.
				yield* write(two, "two")
				yield* fs.remove(request)
				yield* fs.symlink(two, request)
				yield* poll
				const unchanged = yield* Queue.size(updates)
				assert.strictEqual(unchanged, 0)
				// The new target remains observable, even with the same file size.
				yield* write(request, "six")
				yield* poll
				const retargeted = yield* Queue.take(updates)
				assert.strictEqual(retargeted, "six")
				// A dangling link keeps the last provider, then recovers without an event.
				yield* fs.remove(two)
				yield* poll
				const failure = yield* Queue.take(logged)
				assert(Cause.hasFails(failure.cause))
				const retained = yield* value
				assert.strictEqual(retained, "six")
				yield* write(two, "new")
				yield* poll
				const restored = yield* Queue.take(updates)
				assert.strictEqual(restored, "new")
				yield* poll
				const repeated = yield* Queue.size(updates)
				assert.strictEqual(repeated, 0)
			}).pipe(
				Effect.scoped,
				Effect.provide(envLayer(request)),
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					watch: () => Stream.never,
				}),
				Effect.provide(layer),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect("logs the full native failure once and reinstalls its source", () =>
	Effect.gen(function* () {
		const { logged, layer } = yield* logging
		const attempts = yield* Queue.unbounded<void>()
		const failed = Cause.die(new Error("Watch failed"))
		const cleanup = Cause.die(new Error("Watch cleanup failed"))
		const cause = Cause.combine(failed, cleanup)
		const fs = FileSystem.layerNoop({
			watch: () =>
				Stream.unwrap(
					Effect.addFinalizer(() => Effect.failCause(cleanup)).pipe(
						Effect.andThen(Queue.offer(attempts, undefined)),
						Effect.as(Stream.failCause(failed)),
					),
				),
		})
		const watcher = yield* watchEnvFile(
			"/app/.env",
			Effect.succeed(false),
			Effect.void,
		).pipe(Effect.provide([fs, Path.layer, layer]), Effect.forkScoped)
		yield* Queue.take(attempts)
		const first = yield* Queue.take(logged)
		assert.deepStrictEqual(first.cause, cause)
		yield* TestClock.adjust("1 second")
		yield* Queue.take(attempts)
		const second = yield* Queue.take(logged)
		assert.deepStrictEqual(second.cause, cause)
		yield* Fiber.interrupt(watcher)
		const remaining = yield* Queue.size(logged)
		assert.strictEqual(remaining, 0)
	}).pipe(Effect.scoped),
)
