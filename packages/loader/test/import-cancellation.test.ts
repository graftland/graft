import { assert, it } from "@effect/vitest"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- native unhandledRejection is delivered on a host event-loop turn, independent of TestClock
import { setImmediate } from "node:timers/promises"
import { Deferred, Effect, Fiber, Path } from "effect"
import { ModuleResolver } from "../src/index.ts"

it.effect(
	"handles a late rejection if cancellation wins after importer invocation",
	() =>
		Effect.gen(function* () {
			// Observe the native Promise boundary, including failures outside Effect.
			const unhandled: unknown[] = []
			const onUnhandled = (cause: unknown) => {
				unhandled.push(cause)
			}
			yield* Effect.acquireRelease(
				Effect.sync(() => process.on("unhandledRejection", onUnhandled)),
				() => Effect.sync(() => process.off("unhandledRejection", onUnhandled)),
			)
			const entered = yield* Deferred.make<void>()
			const imported = Promise.withResolvers<unknown>()
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: () => {
					Deferred.doneUnsafe(entered, Effect.void)
					return imported.promise
				},
			})
			const resolving = yield* resolver.resolve("slow").pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* Fiber.interrupt(resolving)
			imported.reject(new Error("Late import failure"))
			yield* Effect.promise(() => setImmediate())
			assert.deepStrictEqual(unhandled, [])
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)
