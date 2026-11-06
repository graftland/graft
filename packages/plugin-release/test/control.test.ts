import { Deferred, Effect, Fiber, FileSystem, String } from "effect"
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
