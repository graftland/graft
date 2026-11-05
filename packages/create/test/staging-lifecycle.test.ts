import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Path,
	PlatformError,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { create } from "../src/index.ts"

for (const operation of ["write", "rename"] as const) {
	for (const outcome of ["success", "failure"] as const) {
		it.effect(
			`waits for an accepted staging ${operation} ${outcome} before cancellation cleanup`,
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const root = yield* fs.makeTempDirectoryScoped()
					const directory = path.join(root, "example")
					const accepted = yield* Deferred.make<Effect.Effect<void>>()
					const cleanup = yield* Deferred.make<void>()
					const error = PlatformError.systemError({
						_tag: "Unknown",
						module: "FileSystem",
						method: operation === "write" ? "writeFileString" : "rename",
						description: "Accepted operation failed after cancellation",
					})
					const services = yield* Effect.context<never>()
					const runSync = Effect.runSyncWith(services)
					const pending = (
						complete: Effect.Effect<void, PlatformError.PlatformError>,
					) =>
						Effect.callback<void, PlatformError.PlatformError>((resume) => {
							// Native requests can outlive AbortSignal cancellation; only their callback joins them.
							runSync(
								Deferred.succeed(
									accepted,
									Effect.sync(() =>
										resume(
											outcome === "failure" ? Effect.fail(error) : complete,
										),
									),
								),
							)
						})
					const fiber = yield* create({ directory }).pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							makeTempDirectoryScoped: (options) =>
								Effect.acquireRelease(
									fs.makeTempDirectory(options),
									(staging) =>
										Deferred.succeed(cleanup, undefined).pipe(
											Effect.andThen(
												fs.remove(staging, { recursive: true, force: true }),
											),
											Effect.orDie,
										),
								),
							writeFileString: (file, content, options) =>
								operation === "write"
									? pending(fs.writeFileString(file, content, options))
									: fs.writeFileString(file, content, options),
							rename: (from, to) =>
								operation === "rename"
									? pending(fs.rename(from, to))
									: fs.rename(from, to),
						}),
						Effect.forkScoped,
					)
					const complete = yield* Deferred.await(accepted)
					const cancelling = yield* Fiber.interrupt(fiber).pipe(
						Effect.forkScoped,
					)
					yield* Effect.yieldNow
					yield* Effect.yieldNow
					const cleanupStartedEarly = yield* Deferred.isDone(cleanup)
					yield* complete
					yield* Fiber.join(cancelling)
					const exit = yield* Fiber.await(fiber)
					assert.strictEqual(
						cleanupStartedEarly,
						false,
						"Staging cleanup must wait for the accepted operation to complete",
					)
					const cleanupFinished = yield* Deferred.isDone(cleanup)
					assert.strictEqual(cleanupFinished, true)
					assert(Exit.isFailure(exit))
					if (outcome === "failure") {
						assert(
							Array.some(
								exit.cause.reasons,
								(reason) =>
									Cause.isFailReason(reason) && reason.error === error,
							),
							"The accepted operation failure must remain in the final cause",
						)
					}
					// A rename that completed before cancellation is a committed project.
					const entries = yield* fs.readDirectory(root)
					assert.deepStrictEqual(
						entries,
						operation === "rename" && outcome === "success" ? ["example"] : [],
					)
				}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		)
	}
}
