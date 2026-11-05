import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	PlatformError,
	String,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { assert, it } from "@effect/vitest"

import { run, setup, success } from "./fixtures.ts"

for (const defect of [false, true]) {
	it.effect(
		`returns a committed result with the complete snapshot cleanup ${defect ? "defect" : "failure"}`,
		() =>
			Effect.gen(function* () {
				const { fs, directory, path, write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				const denied = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "FileSystem",
					method: "remove",
				})
				const pm = yield* manager(() => success, {
					...fs,
					makeTempDirectory: () =>
						fs.makeTempDirectory({ directory, prefix: "snapshot-" }),
					remove: (file, options) =>
						String.startsWith("snapshot-")(path.basename(file))
							? defect
								? Effect.die("snapshot cleanup defect")
								: Effect.fail(denied)
							: fs.remove(file, options),
				})
				const exit = yield* Effect.exit(pm.install({ added: "1" }))
				assert(
					Exit.isSuccess(exit),
					"Snapshot disposal must not hide a committed install",
				)
				const report = Option.getOrThrow(exit.value.snapshotCleanupFailure)
				assert.strictEqual(report.cause.reasons.length, 1)
				assert(
					Array.some(report.cause.reasons, (reason) =>
						defect
							? Cause.isDieReason(reason) &&
								reason.defect === "snapshot cleanup defect"
							: Cause.isFailReason(reason) && reason.error === denied,
					),
				)
				const retained = yield* fs.exists(report.snapshotDirectory)
				assert.strictEqual(retained, true)
				const before = yield* fs.readFileString(
					path.join(report.snapshotDirectory, "0.bin"),
				)
				assert.strictEqual(before, "{}")
				const manifest = yield* read("package.json")
				assert.strictEqual(manifest, '{"dependencies": {"added": "1"}}')
				assert.deepStrictEqual(
					Array.map(exit.value.added, (change) => change.name),
					["added"],
				)
				const recovery = yield* pm.recoveryRequired
				assert(Option.isNone(recovery))
				const next = yield* pm.install({ later: "2" })
				assert.deepStrictEqual(
					Array.map(next.added, (change) => change.name),
					["later"],
				)
			}).pipe(run),
	)
}

it.effect(
	"preserves installation and cleanup failures when the transaction rolls back",
	() =>
		Effect.gen(function* () {
			const { fs, directory, path, write, read, manager } = yield* setup
			yield* write("package.json", "{}")
			const denied = PlatformError.systemError({
				_tag: "PermissionDenied",
				module: "FileSystem",
				method: "remove",
			})
			const pm = yield* manager(
				() => Effect.succeed(ChildProcessSpawner.ExitCode(7)),
				{
					...fs,
					makeTempDirectory: () =>
						fs.makeTempDirectory({ directory, prefix: "snapshot-" }),
					remove: (file, options) =>
						String.startsWith("snapshot-")(path.basename(file))
							? Effect.fail(denied)
							: fs.remove(file, options),
				},
			)
			const result = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(result))
			assert(
				Array.some(
					result.cause.reasons,
					(reason) =>
						Cause.isFailReason(reason) &&
						reason.error._tag === "PackageManagerError",
				),
			)
			assert(
				Array.some(
					result.cause.reasons,
					(reason) => Cause.isFailReason(reason) && reason.error === denied,
				),
			)
			const manifest = yield* read("package.json")
			assert.strictEqual(manifest, "{}")
		}).pipe(run),
)

it.effect("holds the lock until post-commit cleanup has completed", () =>
	Effect.gen(function* () {
		const { fs, directory, path, write, manager } = yield* setup
		yield* write("package.json", "{}")
		const entered = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		const pm = yield* manager(() => success, {
			...fs,
			makeTempDirectory: () =>
				fs.makeTempDirectory({ directory, prefix: "snapshot-" }),
			remove: (file, options) =>
				String.startsWith("snapshot-")(path.basename(file))
					? Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(fs.remove(file, options)),
						)
					: fs.remove(file, options),
		})
		const installing = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
		yield* Deferred.await(entered)
		const queued = yield* pm.readState.pipe(Effect.forkScoped)
		yield* Effect.yieldNow
		const premature = queued.pollUnsafe()
		yield* Deferred.succeed(release, undefined)
		const result = yield* Fiber.join(installing)
		yield* Fiber.join(queued)
		assert.strictEqual(premature, undefined)
		assert(Option.isNone(result.snapshotCleanupFailure))
	}).pipe(run),
)

it.effect(
	"retains cleanup failures when cancellation arrives after commit",
	() =>
		Effect.gen(function* () {
			const { fs, directory, path, write, read, manager } = yield* setup
			yield* write("package.json", "{}")
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const denied = PlatformError.systemError({
				_tag: "PermissionDenied",
				module: "FileSystem",
				method: "remove",
			})
			const pm = yield* manager(() => success, {
				...fs,
				makeTempDirectory: () =>
					fs.makeTempDirectory({ directory, prefix: "snapshot-" }),
				remove: (file, options) =>
					String.startsWith("snapshot-")(path.basename(file))
						? Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(Effect.fail(denied)),
							)
						: fs.remove(file, options),
			})
			const installing = yield* pm
				.install({ added: "1" })
				.pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			const cancelling = yield* Fiber.interrupt(installing).pipe(
				Effect.forkScoped,
			)
			yield* Effect.yieldNow
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(cancelling)
			const result = yield* Fiber.await(installing)
			const cause = Exit.isFailure(result)
				? result.cause
				: Option.getOrThrow(result.value.snapshotCleanupFailure).cause
			assert(
				Array.some(
					cause.reasons,
					(reason) => Cause.isFailReason(reason) && reason.error === denied,
				),
			)
			const manifest = yield* read("package.json")
			assert.strictEqual(manifest, '{"dependencies": {"added": "1"}}')
		}).pipe(run),
)
