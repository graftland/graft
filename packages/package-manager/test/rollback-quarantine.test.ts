import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	PlatformError,
	Ref,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { run, setup } from "./fixtures.ts"

for (const { failure, restoreFailure, recoveryCode } of [
	{ failure: "first restore", restoreFailure: 1, recoveryCode: 0 },
	{ failure: "recovery", restoreFailure: 0, recoveryCode: 9 },
	{ failure: "second restore", restoreFailure: 2, recoveryCode: 0 },
	{
		failure: "recovery and second restore",
		restoreFailure: 2,
		recoveryCode: 9,
	},
]) {
	it.effect(
		`retains the snapshot and rejects queued installs after a failed ${failure}`,
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, read, manager } = yield* setup
				yield* write("package.json", "{}\r\n")
				yield* write("package-lock.json", "original lock")
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const restores = yield* Ref.make(0)
				const broken = yield* Ref.make(true)
				const denied = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "FileSystem",
					method: "writeFile",
				})
				const pause = Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Deferred.await(release)),
				)
				const pm = yield* manager(
					() =>
						Effect.gen(function* () {
							const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
							if (call === 1) return ChildProcessSpawner.ExitCode(7)
							if (call === 2 && recoveryCode !== 0) {
								yield* pause
								return ChildProcessSpawner.ExitCode(recoveryCode)
							}
							return ChildProcessSpawner.ExitCode(0)
						}),
					{
						...fs,
						rename: (from, file) =>
							Effect.gen(function* () {
								if (file === path.join(directory, "package.json")) {
									const restore = yield* Ref.updateAndGet(
										restores,
										(n) => n + 1,
									)
									if ((yield* Ref.get(broken)) && restore === restoreFailure) {
										yield* pause
										return yield* denied
									}
								}
								yield* fs.rename(from, file)
							}),
					},
				)
				const first = yield* pm.install({ failed: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const queuedStarted = yield* Deferred.make<void>()
				const queued = yield* Deferred.succeed(queuedStarted, undefined).pipe(
					Effect.andThen(pm.install({ later: "2" })),
					Effect.forkScoped,
				)
				yield* Deferred.await(queuedStarted)
				yield* Deferred.succeed(release, undefined)
				const exit = yield* Fiber.await(first)
				assert(Exit.isFailure(exit))
				const status = yield* pm.recoveryRequired
				assert(
					Option.isSome(status),
					"Failed rollback must require manual recovery",
				)
				assert.strictEqual(status.value.operation, "rollback")
				assert.deepStrictEqual(
					status.value.recoveryCause.reasons,
					Array.filter(
						exit.cause.reasons,
						(reason) =>
							!(Cause.isFailReason(reason) && reason.error === status.value),
					),
				)
				const retained = yield* fs.exists(status.value.snapshotDirectory)
				assert.strictEqual(retained, true)
				const original = yield* fs.readFileString(
					path.join(status.value.snapshotDirectory, "0.bin"),
				)
				assert.strictEqual(original, "{}\r\n")
				assert(
					Array.some(
						exit.cause.reasons,
						(reason) =>
							Cause.isFailReason(reason) &&
							reason.error._tag === "PackageManagerError",
					),
				)
				if (restoreFailure !== 0)
					assert(
						Array.some(
							exit.cause.reasons,
							(reason) => Cause.isFailReason(reason) && reason.error === denied,
						),
					)
				const second = yield* Fiber.await(queued)
				assert(Exit.isFailure(second))
				const reason = Option.getOrThrow(Cause.findErrorOption(second.cause))
				assert.strictEqual(reason, status.value)
				yield* Ref.set(broken, false)
				const beforeRetry = yield* read("package.json")
				const retry = yield* Effect.exit(pm.install({}))
				assert(Exit.isFailure(retry))
				const afterRetry = yield* read("package.json")
				assert.strictEqual(afterRetry, beforeRetry)
				const spawned = yield* Ref.get(calls)
				assert.strictEqual(spawned, failure === "first restore" ? 1 : 2)
			}).pipe(run),
	)
}

it.effect(
	"replaces an installer-made read-only manifest with its original permissions",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory, write, manager } = yield* setup
			yield* write("package.json", "{}")
			const manifest = path.join(directory, "package.json")
			const before = yield* fs.stat(manifest)
			const pm = yield* manager(() =>
				fs
					.chmod(manifest, 0o400)
					.pipe(Effect.as(ChildProcessSpawner.ExitCode(7))),
			)
			const result = yield* Effect.exit(pm.install({ failed: "1" }))
			assert(Exit.isFailure(result))
			const status = yield* pm.recoveryRequired
			assert(Option.isNone(status))
			const after = yield* fs.stat(manifest)
			assert.strictEqual(after.mode, before.mode)
			const text = yield* fs.readFileString(manifest)
			assert.strictEqual(text, "{}")
		}).pipe(run),
)
