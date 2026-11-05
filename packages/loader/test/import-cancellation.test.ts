// @effect-diagnostics-next-line nodeBuiltinImport:off -- native unhandledRejection is delivered on a host event-loop turn, independent of TestClock
import { setImmediate } from "node:timers/promises"

import {
	Array,
	Deferred,
	Effect,
	Fiber,
	Logger,
	MutableList,
	Path,
} from "effect"
import { assert, it } from "@effect/vitest"

import { ModuleResolver } from "../src/index.ts"

it.effect(
	"handles a late rejection if cancellation wins after importer invocation",
	() =>
		Effect.gen(function* () {
			// Observe the native Promise boundary, including failures outside Effect.
			const unhandled = MutableList.make<unknown>()
			const logs = MutableList.make<Logger.Options<unknown>>()
			const marker = new Error("Late import failure")
			const onUnhandled = (cause: unknown) => {
				MutableList.append(unhandled, cause)
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
			const resolving = yield* resolver.resolve("slow").pipe(
				Effect.provide(
					Logger.layer([
						Logger.make((entry) => {
							MutableList.append(logs, entry)
						}),
					]),
				),
				Effect.forkScoped,
			)
			yield* Deferred.await(entered)
			yield* Fiber.interrupt(resolving)
			imported.reject(marker)
			yield* Effect.promise(() => setImmediate())
			assert.deepStrictEqual(MutableList.toArray(unhandled), [])
			assert.isTrue(
				Array.some(MutableList.toArray(logs), (log) =>
					Array.some(
						log.cause.reasons,
						(reason) =>
							(reason._tag === "Die" && reason.defect === marker) ||
							(reason._tag === "Fail" && reason.error === marker),
					),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)
