// @effect-diagnostics-next-line nodeBuiltinImport:off -- A raw server deliberately withholds HTTP headers to test transport cancellation.
import { createServer } from "node:http"

import { Cause, Deferred, Effect, Fiber, FileSystem, String } from "effect"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { call, serve } from "../src/Control"
import { failure } from "../src/internal/storage"
import { Releases } from "../src/Model"

it.effect(
	"keeps the request connection open while a control operation waits",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped({
				directory: "/tmp",
				prefix: "release-control-",
			})
			const entered = yield* Deferred.make<void>()
			const ready = yield* Deferred.make<void>()
			const id = String.repeat(64)("a")
			const service = Releases.of({
				build: () => failure("Unsupported", "Build is not used by this test"),
				plan: (target) =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(ready)),
						Effect.as({ current: id, target, changes: [], diagnostics: [] }),
					),
				apply: () => failure("Unsupported", "Apply is not used by this test"),
				rollback: () =>
					failure("Unsupported", "Rollback is not used by this test"),
				observe: Effect.succeed({
					current: id,
					previous: null,
					state: "Ready",
					revocations: [],
				}),
				history: Effect.succeed([]),
			})
			const socket = directory + "/control.sock"
			yield* serve(socket, service)
			const fiber = yield* Effect.forkScoped(
				call(socket, { _tag: "plan", target: id }),
			)
			yield* Deferred.await(entered)
			yield* Deferred.succeed(ready, undefined)
			const result = yield* Fiber.join(fiber)
			assert.equal(result.ok, true)
			assert.deepEqual(result.value, {
				current: id,
				target: id,
				changes: [],
				diagnostics: [],
			})
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

for (const mode of ["deadline", "caller timeout", "interruption"] as const) {
	it.effect(
		`releases the connection on ${mode} while the server never sends headers`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped({
					directory: "/tmp",
					prefix: "release-timeout-",
				})
				const socket = directory + "/control.sock"
				const connected = yield* Deferred.make<void>()
				const closed = yield* Deferred.make<void>()
				const server = yield* Effect.acquireRelease(
					Effect.sync(() =>
						createServer((request, response) => {
							request.resume()
							response.once("close", () =>
								Deferred.doneUnsafe(closed, Effect.void),
							)
							Deferred.doneUnsafe(connected, Effect.void)
						}),
					),
					(server) =>
						Effect.callback<void>((resume) => {
							server.closeAllConnections()
							server.close((error) =>
								resume(error === undefined ? Effect.void : Effect.die(error)),
							)
						}),
				)
				yield* Effect.callback<void>((resume) => {
					server.once("error", (error) => resume(Effect.die(error)))
					server.listen(socket, () => resume(Effect.void))
				})
				const request = call(socket, { _tag: "status" })
				const fiber = yield* Effect.forkScoped(
					mode === "caller timeout"
						? request.pipe(Effect.timeout("40 millis"))
						: request,
				)
				yield* Deferred.await(connected)
				if (mode === "interruption") yield* Fiber.interrupt(fiber)
				else
					yield* TestClock.adjust(
						mode === "deadline" ? "10 minutes" : "40 millis",
					)
				const result = yield* Fiber.await(fiber)
				assert.equal(result._tag, "Failure")
				if (result._tag === "Failure" && mode === "interruption")
					assert.isTrue(Cause.hasInterrupts(result.cause))
				yield* Deferred.await(closed)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
}
