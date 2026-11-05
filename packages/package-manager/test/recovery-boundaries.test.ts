import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	PlatformError,
	Ref,
	String,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { run, setup } from "./fixtures.ts"

const failure = Effect.succeed(ChildProcessSpawner.ExitCode(7))
const denied = (path: string) =>
	PlatformError.systemError({
		_tag: "PermissionDenied",
		module: "FileSystem",
		method: "writeFile",
		pathOrDescriptor: path,
	})

describe("recovery boundaries", () => {
	it.effect(
		"does not mutate or spawn when interrupted while reading backups",
		() =>
			Effect.gen(function* () {
				const { fs, write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				yield* write("package-lock.json", "lock")
				const reached = yield* Deferred.make<void>()
				const pm = yield* manager(() => Effect.die("must not spawn"), {
					...fs,
					readFile: (file) =>
						String.endsWith("package-lock.json")(file)
							? Deferred.succeed(reached, undefined).pipe(
									Effect.andThen(Effect.never),
								)
							: fs.readFile(file),
				})
				const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(reached)
				yield* Fiber.interrupt(fiber)
				const observed1 = yield* read("package.json")
				assert.strictEqual(observed1, "{}")
			}).pipe(run),
	)

	it.effect(
		"restores a partially written manifest before any process starts",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				const releaseWrite = yield* Deferred.make<void>()
				const reached = yield* Deferred.make<void>()
				const pm = yield* manager(() => Effect.die("must not spawn"), {
					...fs,
					writeFileString: (file, text, options) =>
						file === path.join(directory, "package.json")
							? fs
									.writeFileString(file, "partial")
									.pipe(
										Effect.andThen(Deferred.succeed(reached, undefined)),
										Effect.andThen(Deferred.await(releaseWrite)),
									)
							: fs.writeFileString(file, text, options),
				})
				const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(reached)
				const cancelling = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped)
				yield* Deferred.succeed(releaseWrite, undefined)
				yield* Fiber.join(cancelling)
				const observed2 = yield* read("package.json")
				assert.strictEqual(observed2, "{}")
			}).pipe(run),
	)

	it.effect(
		"preserves the original failure and every restoration failure while restoring other files",
		() =>
			Effect.gen(function* () {
				const { fs, write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				yield* write("package-lock.json", "lock")
				yield* write(".npmrc", "original config")
				const calls = yield* Ref.make(0)
				const pm = yield* manager(
					() =>
						Ref.update(calls, (n) => n + 1).pipe(
							Effect.andThen(write(".npmrc", "changed config")),
							Effect.andThen(failure),
						),
					{
						...fs,
						rename: (from, file) =>
							String.endsWith("package.json")(file) ||
							String.endsWith("package-lock.json")(file)
								? Effect.fail(denied(file))
								: fs.rename(from, file),
					},
				)
				const exit = yield* Effect.exit(pm.install({ added: "1" }))
				assert(Exit.isFailure(exit))
				const errors = Array.filter(exit.cause.reasons, Cause.isFailReason)
				assert.strictEqual(errors.length, 4)
				assert.deepStrictEqual(
					Array.map(errors, (reason) => reason.error._tag),
					[
						"PackageManagerError",
						"PlatformError",
						"PlatformError",
						"RecoveryRequiredError",
					],
				)
				const observed3 = yield* read(".npmrc")

				assert.strictEqual(observed3, "original config")
				// Installing against files that failed restoration would compound the damage.
				const observed4 = yield* Ref.get(calls)
				assert.strictEqual(observed4, 1)
			}).pipe(run),
	)

	it.effect(
		"recreates a removed parent directory for backed-up Yarn state",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, read, manager } = yield* setup
				yield* write("package.json", '{"packageManager":"yarn@4.9.0"}')
				yield* write("yarn.lock", "original lock")
				yield* fs.makeDirectory(path.join(directory, ".yarn"))
				yield* write(".yarn/install-state.gz", "original state")
				const calls = yield* Ref.make(0)
				const pm = yield* manager(() =>
					Effect.gen(function* () {
						const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
						if (call === 1) {
							yield* fs.remove(path.join(directory, ".yarn"), {
								recursive: true,
							})
							return ChildProcessSpawner.ExitCode(7)
						}
						const observed5 = yield* read(".yarn/install-state.gz")
						assert.strictEqual(observed5, "original state")
						return ChildProcessSpawner.ExitCode(0)
					}),
				)
				const exit = yield* Effect.exit(pm.install({ added: "1" }))
				assert(Exit.isFailure(exit))
				assert.strictEqual(
					Array.filter(exit.cause.reasons, Cause.isFailReason).length,
					1,
				)
				const observed6 = yield* read(".yarn/install-state.gz")

				assert.strictEqual(observed6, "original state")
				const observed7 = yield* Ref.get(calls)

				assert.strictEqual(observed7, 2)
			}).pipe(run),
	)

	it.effect(
		"bounds a hung recovery process and restores files after its finalizer",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				yield* write("package-lock.json", "lock")
				const reached = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const pm = yield* manager(() =>
					Effect.gen(function* () {
						const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
						if (call === 1) return ChildProcessSpawner.ExitCode(7)
						yield* Deferred.succeed(reached, undefined)
						return yield* Effect.never.pipe(
							Effect.onExit(() => write("package.json", "recovery finalizer")),
						)
					}),
				)
				const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(reached)
				yield* TestClock.adjust("10 minutes")
				const exit = yield* Fiber.await(fiber)
				assert(Exit.isFailure(exit))
				const errors = Array.map(
					Array.filter(exit.cause.reasons, Cause.isFailReason),
					(reason) => reason.error,
				)
				assert.strictEqual(errors.length, 3)
				assert.strictEqual(errors[2]?._tag, "RecoveryRequiredError")
				const observed8 = yield* read("package.json")

				assert.strictEqual(observed8, "{}")
			}).pipe(run),
	)

	it.effect(
		"holds the install lock throughout rollback and lets a queued install proceed afterwards",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				yield* write("package-lock.json", "lock")
				const recovering = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const queued = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const pm = yield* manager(() =>
					Effect.gen(function* () {
						const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
						if (call === 1) return ChildProcessSpawner.ExitCode(7)
						if (call === 2) {
							yield* Deferred.succeed(recovering, undefined)
							yield* Deferred.await(release)
						}
						return ChildProcessSpawner.ExitCode(0)
					}),
				)
				const first = yield* pm.install({ failed: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(recovering)
				const second = yield* Deferred.succeed(queued, undefined).pipe(
					Effect.andThen(pm.install({ retained: "2" })),
					Effect.forkScoped,
				)
				yield* Deferred.await(queued)
				const observed9 = yield* Ref.get(calls)
				assert.strictEqual(observed9, 2)
				yield* Deferred.succeed(release, undefined)
				const observed10 = yield* Fiber.await(first)
				assert(Exit.isFailure(observed10))
				yield* Fiber.join(second)
				const observed11 = yield* read("package.json")
				assert.strictEqual(observed11, '{"dependencies": {"retained": "2"}}')
			}).pipe(run),
	)
	it.effect(
		"finishes restoring every file when cancellation arrives during rollback",
		() =>
			Effect.gen(function* () {
				const { fs, write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				yield* write(".npmrc", "original config")
				const restoring = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const pm = yield* manager(
					() =>
						write(".npmrc", "modified config").pipe(Effect.andThen(failure)),
					{
						...fs,
						rename: (from, file) =>
							Deferred.succeed(restoring, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(fs.rename(from, file)),
							),
					},
				)
				const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(restoring)
				const interruption = yield* Fiber.interrupt(fiber).pipe(
					Effect.forkScoped,
				)
				yield* Effect.yieldNow
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(interruption)
				const manifest = yield* read("package.json")
				const config = yield* read(".npmrc")
				assert.strictEqual(manifest, "{}")
				assert.strictEqual(config, "original config")
			}).pipe(run),
	)
})
