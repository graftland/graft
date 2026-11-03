import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import type { PlatformError } from "effect"
import { run, setup } from "./fixtures.ts"

it.effect(
	"joins an accepted file write before rollback and releases the lock afterwards",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory, write, read, manager } = yield* setup
			yield* write("package.json", "{}")
			const target = path.join(directory, "package.json")
			const accepted =
				yield* Deferred.make<Effect.Effect<void, PlatformError.PlatformError>>()
			const services = yield* Effect.context<never>()
			const runSync = Effect.runSyncWith(services)
			const aborted = yield* Deferred.make<void>()
			const pm = yield* manager(() => Effect.die("Installer must not start"), {
				...fs,
				writeFileString: (file, text, options) =>
					file !== target
						? fs.writeFileString(file, text, options)
						: Effect.callback<void, PlatformError.PlatformError>(
								(resume, signal) => {
									signal.addEventListener(
										"abort",
										() => runSync(Deferred.succeed(aborted, undefined)),
										{ once: true },
									)
									// Model an accepted native operation whose cancellation cannot revoke the write.
									runSync(
										Deferred.succeed(
											accepted,
											fs
												.writeFileString(file, text, options)
												.pipe(
													Effect.onExit((exit) =>
														Effect.sync(() => resume(exit)),
													),
												),
										),
									)
								},
							),
			})
			const installing = yield* pm
				.install({ added: "1" })
				.pipe(Effect.forkScoped)
			const complete = yield* Deferred.await(accepted).pipe(
				Effect.flatMap(Effect.cached),
			)
			yield* Effect.acquireUseRelease(
				Effect.void,
				() =>
					Effect.gen(function* () {
						const cancelling = yield* Fiber.interrupt(installing).pipe(
							Effect.forkScoped,
						)
						yield* Effect.yieldNow
						const queued = yield* pm.readState.pipe(Effect.forkScoped)
						yield* Effect.yieldNow
						const wasAborted = yield* Deferred.isDone(aborted)
						const cancellation = cancelling.pollUnsafe()
						const reading = queued.pollUnsafe()
						// Complete the native operation before any assertion can fail and close the scope.
						yield* complete
						yield* Fiber.join(cancelling)
						const queuedExit = yield* Fiber.await(queued)
						assert.strictEqual(
							wasAborted,
							false,
							"An accepted write must finish without aborting",
						)
						assert(
							cancellation === undefined,
							"Cancellation must join the accepted write",
						)
						assert(
							reading === undefined,
							"The lock must remain held during the write",
						)
						assert(Exit.isSuccess(queuedExit))
						const manifest = yield* read("package.json")
						assert.strictEqual(manifest, "{}")
						const status = yield* pm.recoveryRequired
						assert(Option.isNone(status))
					}),
				() => complete,
			)
		}).pipe(run),
)
