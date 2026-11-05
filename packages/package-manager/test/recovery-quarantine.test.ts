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
	Schema,
	String,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { handle, run, setup, success } from "./fixtures.ts"

for (const operation of ["install", "recover"] as const) {
	it.effect(
		`quarantines an unconfirmed ${operation} process and keeps its recovery snapshot`,
		() =>
			Effect.gen(function* () {
				const { write, read, fs, path, directory, managerWithSpawner } =
					yield* setup
				const original = "{}\r\n"
				const lockBytes = new Uint8Array([0, 255, 13, 10])
				yield* write("package.json", original)
				yield* fs.writeFile(
					path.join(directory, "package-lock.json"),
					lockBytes,
				)
				const started = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const cleanupError = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "ChildProcess",
					method: "kill",
				})
				const pm = yield* managerWithSpawner(
					ChildProcessSpawner.make(() =>
						Effect.gen(function* () {
							const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
							if (call > (operation === "install" ? 1 : 2))
								return handle(success)
							if (operation === "recover" && call === 1)
								return handle(Effect.succeed(ChildProcessSpawner.ExitCode(7)))
							return ChildProcessSpawner.makeHandle({
								...handle(
									write("package.json", "live process write").pipe(
										Effect.andThen(
											write("package-lock.json", "live lock write"),
										),
										Effect.andThen(Deferred.succeed(started, undefined)),
										Effect.andThen(Effect.never),
									),
								),
								isRunning: Effect.succeed(true),
								kill: () => Effect.fail(cleanupError),
							})
						}),
					),
				)
				const first = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(started)
				const queuedStarted = yield* Deferred.make<void>()
				const queued = yield* Deferred.succeed(queuedStarted, undefined).pipe(
					Effect.andThen(pm.install({ next: "2" })),
					Effect.forkScoped,
				)
				yield* Deferred.await(queuedStarted)
				if (operation === "install") yield* Fiber.interrupt(first)
				else yield* TestClock.adjust("10 minutes")
				const exit = yield* Fiber.await(first)
				assert(Exit.isFailure(exit))
				assert(
					Array.some(
						exit.cause.reasons,
						(reason) =>
							Cause.isFailReason(reason) && reason.error === cleanupError,
					),
				)
				const spawned = yield* Ref.get(calls)
				assert.strictEqual(
					spawned,
					operation === "install" ? 1 : 2,
					"Recovery must not overlap an unconfirmed process",
				)
				const current = yield* read("package.json")
				assert.strictEqual(
					current,
					"live process write",
					"Restoration must not race with the process",
				)
				const blocked = yield* Fiber.await(queued)
				assert(Exit.isFailure(blocked))
				const reason = Option.getOrThrow(Cause.findErrorOption(blocked.cause))
				assert.strictEqual(reason._tag, "RecoveryRequiredError")
				if (reason._tag !== "RecoveryRequiredError") return
				assert.strictEqual(reason.operation, operation)
				const status = yield* pm.recoveryRequired
				assert(Option.isSome(status))
				assert.strictEqual(
					status.value.snapshotDirectory,
					reason.snapshotDirectory,
				)
				yield* Effect.addFinalizer(() =>
					fs
						.remove(reason.snapshotDirectory, { recursive: true })
						.pipe(Effect.orDie),
				)
				const inventory = yield* fs
					.readFileString(path.join(reason.snapshotDirectory, "snapshot.json"))
					.pipe(
						Effect.flatMap(
							Schema.decodeEffect(
								Schema.fromJsonString(
									Schema.Struct({
										directory: Schema.String,
										files: Schema.Array(
											Schema.Struct({
												name: Schema.String,
												backup: Schema.NullOr(Schema.String),
											}),
										),
									}),
								),
							),
						),
					)
				assert.strictEqual(inventory.directory, directory)
				for (const [name, expected] of [
					["package.json", new TextEncoder().encode(original)],
					["package-lock.json", lockBytes],
				] as const) {
					const entry = Option.getOrThrow(
						Array.findFirst(inventory.files, (entry) => entry.name === name),
					)
					assert(entry.backup !== null)
					const bytes = yield* fs.readFile(
						path.join(reason.snapshotDirectory, entry.backup),
					)
					assert.deepStrictEqual(bytes, expected)
				}
				const absent = Option.getOrThrow(
					Array.findFirst(inventory.files, (entry) => entry.name === ".npmrc"),
				)
				assert.strictEqual(absent.backup, null)
				const retry = yield* Effect.exit(pm.install({}))
				assert(Exit.isFailure(retry))
				const after = yield* Ref.get(calls)
				assert.strictEqual(after, spawned)
			}).pipe(run),
	)
}

for (const interrupted of [false, true]) {
	it.effect(
		`leaves the project untouched when snapshot creation ${interrupted ? "is interrupted" : "fails"}`,
		() =>
			Effect.gen(function* () {
				const { write, read, fs, directory, managerWithSpawner } = yield* setup
				yield* write("package.json", "{}")
				const entered = yield* Deferred.make<void>()
				const releaseWrite = yield* Deferred.make<void>()
				const snapshotPath = yield* Ref.make(Option.none<string>())
				const failure = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "FileSystem",
					method: "writeFile",
				})
				const pm = yield* managerWithSpawner(
					ChildProcessSpawner.make(() =>
						Effect.die("Must not spawn before the snapshot is complete"),
					),
					{
						...fs,
						makeTempDirectory: () =>
							fs
								.makeTempDirectory({ directory, prefix: "snapshot-" })
								.pipe(
									Effect.tap((path) =>
										Ref.set(snapshotPath, Option.some(path)),
									),
								),
						writeFile: (file, bytes, options) =>
							String.endsWith(".bin")(file)
								? Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(
											interrupted
												? Deferred.await(releaseWrite)
												: Effect.fail(failure),
										),
									)
								: fs.writeFile(file, bytes, options),
					},
				)
				const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				if (interrupted) {
					const cancelling = yield* Fiber.interrupt(fiber).pipe(
						Effect.forkScoped,
					)
					yield* Deferred.succeed(releaseWrite, undefined)
					yield* Fiber.join(cancelling)
				}
				const exit = yield* Fiber.await(fiber)
				assert(Exit.isFailure(exit))
				const current = yield* read("package.json")
				assert.strictEqual(current, "{}")
				const status = yield* pm.recoveryRequired
				assert(Option.isNone(status))
				const savedPath = yield* Ref.get(snapshotPath)
				const saved = Option.getOrThrow(savedPath)
				const retained = yield* fs.exists(saved)
				assert.strictEqual(retained, false)
			}).pipe(run),
	)
}

for (const code of [0, 7]) {
	it.effect(
		`removes the snapshot after a stopped installer exits with code ${code}`,
		() =>
			Effect.gen(function* () {
				const { write, fs, directory, managerWithSpawner } = yield* setup
				yield* write("package.json", "{}")
				const snapshotPath = yield* Ref.make(Option.none<string>())
				const pm = yield* managerWithSpawner(
					ChildProcessSpawner.make(() =>
						Effect.succeed(
							handle(Effect.succeed(ChildProcessSpawner.ExitCode(code))),
						),
					),
					{
						...fs,
						makeTempDirectory: () =>
							fs
								.makeTempDirectory({ directory, prefix: "snapshot-" })
								.pipe(
									Effect.tap((path) =>
										Ref.set(snapshotPath, Option.some(path)),
									),
								),
					},
				)
				const exit = yield* Effect.exit(pm.install({}))
				assert.strictEqual(Exit.isSuccess(exit), code === 0)
				const savedPath = yield* Ref.get(snapshotPath)
				const saved = Option.getOrThrow(savedPath)
				const retained = yield* fs.exists(saved)
				assert.strictEqual(retained, false)
				const status = yield* pm.recoveryRequired
				assert(Option.isNone(status))
			}).pipe(run),
	)
}

it.effect(
	"quarantines a cleanup defect thrown before the kill Effect is returned",
	() =>
		Effect.gen(function* () {
			const { write, read, managerWithSpawner } = yield* setup
			yield* write("package.json", "{}")
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make(() =>
					Effect.succeed(
						ChildProcessSpawner.makeHandle({
							...handle(success),
							kill: () => {
								throw "kill construction defect"
							},
						}),
					),
				),
			)
			const exit = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(exit))
			assert(
				Array.some(
					exit.cause.reasons,
					(reason) =>
						Cause.isDieReason(reason) &&
						reason.defect === "kill construction defect",
				),
			)
			const status = yield* pm.recoveryRequired
			assert(Option.isSome(status))
			const retry = yield* Effect.exit(pm.install({}))
			assert(Exit.isFailure(retry))
			const current = yield* read("package.json")
			assert.strictEqual(current, '{"dependencies": {"added": "1"}}')
		}).pipe(run),
)
