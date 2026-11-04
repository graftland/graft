import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	PlatformError,
	Schema,
	Schedule,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { PackageManagerError } from "../src/index.ts"
import { handle, run, setup } from "./fixtures.ts"

describe("installer process lifetime", () => {
	for (const cancellation of ["timeout", "interrupt"] as const) {
		it.effect(
			`retains process cleanup defects on ${cancellation} before restoring files`,
			() =>
				Effect.gen(function* () {
					const { write, read, managerWithSpawner } = yield* setup
					yield* write("package.json", "{}")
					yield* write("package-lock.json", "original lock")
					const started = yield* Deferred.make<void>()
					const calls = yield* Ref.make(0)
					const pm = yield* managerWithSpawner(
						ChildProcessSpawner.make(() =>
							Effect.gen(function* () {
								const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
								yield* Effect.addFinalizer(() =>
									write("package.json", "process cleanup write").pipe(
										Effect.orDie,
										Effect.andThen(
											Effect.die(
												call === 1
													? "install cleanup failed"
													: "recovery cleanup failed",
											),
										),
									),
								)
								if (call === 2) {
									const restored = yield* read("package.json")
									assert.strictEqual(restored, "{}")
								}
								return handle(
									call === 1
										? Deferred.succeed(started, undefined).pipe(
												Effect.andThen(Effect.never),
											)
										: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
								)
							}),
						),
					)
					const fiber = yield* pm
						.install({ added: "1" })
						.pipe(Effect.forkScoped)
					yield* Deferred.await(started)
					if (cancellation === "timeout") yield* TestClock.adjust("10 minutes")
					else yield* Fiber.interrupt(fiber)
					const exit = yield* Fiber.await(fiber)
					assert(Exit.isFailure(exit))
					const defects = Array.map(
						Array.filter(exit.cause.reasons, Cause.isDieReason),
						(reason) => reason.defect,
					)
					assert(Array.contains(defects, "install cleanup failed"))
					assert(Array.contains(defects, "recovery cleanup failed"))
					const errors = Array.filter(defects, Schema.is(PackageManagerError))
					assert(
						Array.some(
							errors,
							(error) => error.operation === "recover" && error.exitCode === 9,
						),
					)
					if (cancellation === "timeout")
						assert(
							Array.some(
								errors,
								(error) =>
									error.operation === "install" &&
									String.includes("timed out")(error.message),
							),
						)
					else assert(Array.some(exit.cause.reasons, Cause.isInterruptReason))
					const manifest = yield* read("package.json")
					const lockfile = yield* read("package-lock.json")
					assert.strictEqual(manifest, "{}")
					assert.strictEqual(lockfile, "original lock")
				}).pipe(run),
		)
	}
})

for (const operation of ["install", "recover"] as const) {
	it.effect(
		`terminates the ${operation} process that ignores SIGTERM before restoring files`,
		() =>
			Effect.gen(function* () {
				const { write, read, fs, path, directory, managerWithSpawner } =
					yield* setup
				yield* write("package.json", "{}")
				if (operation === "recover") yield* write("package-lock.json", "lock")
				const real = yield* ChildProcessSpawner.ChildProcessSpawner
				const running =
					yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>()
				const pm = yield* managerWithSpawner(
					ChildProcessSpawner.make(
						Effect.fnUntraced(function* (command) {
							if (command._tag !== "StandardCommand")
								return yield* Effect.die("Unexpected pipeline")
							if (
								operation === "recover" &&
								!Array.contains(command.args, "--prefer-offline")
							)
								return handle(Effect.succeed(ChildProcessSpawner.ExitCode(1)))
							const child = yield* real.spawn(
								ChildProcess.make(
									"node",
									[
										"-e",
										`
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
       fs.writeFileSync("term", "");
       fs.writeFileSync("package.json", "termination write");
      });
      fs.writeFileSync("ready", "");
      setTimeout(() => {
       fs.writeFileSync("watchdog", "");
       process.exit(0);
      }, 8000);
     `,
									],
									command.options,
								),
							)
							yield* Deferred.succeed(running, child)
							return child
						}),
					),
				)
				const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				const child = yield* Deferred.await(running)
				yield* fs.exists(path.join(directory, "ready")).pipe(
					Effect.repeat({
						until: (ready) => ready,
						schedule: Schedule.spaced("10 millis"),
					}),
					TestClock.withLive,
				)
				if (operation === "install") yield* Fiber.interrupt(fiber)
				else yield* TestClock.adjust("10 minutes")
				const exit = yield* Fiber.await(fiber)
				assert(Exit.isFailure(exit))
				const isRunning = yield* child.isRunning
				const receivedTerm = yield* fs.exists(path.join(directory, "term"))
				const watchdogFired = yield* fs.exists(path.join(directory, "watchdog"))
				const manifest = yield* read("package.json")
				assert.strictEqual(isRunning, false)
				assert.strictEqual(receivedTerm, true)
				assert.strictEqual(
					watchdogFired,
					false,
					"The process only exited because the test watchdog fired",
				)
				assert.strictEqual(manifest, "{}")
				// The semaphore is released only after process cleanup and file restoration.
				yield* pm.readState
			}).pipe(run),
		15000,
	)
}

it.effect(
	"retains termination errors even when the platform finalizer suppresses them",
	() =>
		Effect.gen(function* () {
			const { write, read, managerWithSpawner } = yield* setup
			yield* write("package.json", "{}")
			const started = yield* Deferred.make<void>()
			const terminationError = PlatformError.systemError({
				_tag: "PermissionDenied",
				module: "ChildProcess",
				method: "kill",
			})
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make(() =>
					Effect.gen(function* () {
						const running = yield* Ref.make(true)
						// Model the Node backend's cleanup policy: suppress a failed termination.
						yield* Effect.addFinalizer(() =>
							Effect.fail(terminationError).pipe(Effect.ignore),
						)
						return ChildProcessSpawner.makeHandle({
							...handle(
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
								),
							),
							isRunning: Ref.get(running),
							kill: () =>
								Ref.set(running, false).pipe(
									Effect.andThen(Effect.fail(terminationError)),
								),
						})
					}),
				),
			)
			const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
			yield* Deferred.await(started)
			yield* Fiber.interrupt(fiber)
			const exit = yield* Fiber.await(fiber)
			assert(Exit.isFailure(exit))
			assert(
				Array.some(
					exit.cause.reasons,
					(reason) =>
						Cause.isFailReason(reason) && reason.error === terminationError,
				),
			)
			assert(Array.some(exit.cause.reasons, Cause.isInterruptReason))
			const current = yield* read("package.json")
			assert.strictEqual(current, '{"dependencies": {"added": "1"}}')
			const status = yield* pm.recoveryRequired
			assert.strictEqual(status._tag, "Some")
		}).pipe(run),
)
