import {
	Effect,
	Fiber,
	FileSystem,
	Option,
	Path,
	Sink,
	Stream,
	type PlatformError,
	type Scope,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"

import { make } from "../src/index.ts"
import { closeProcess } from "../src/process.ts"

export const handle = (
	exitCode: ChildProcessSpawner.ChildProcessHandle["exitCode"],
) =>
	ChildProcessSpawner.makeHandle({
		// A fake handle has no OS group. Avoid PID 1, whose group may exist.
		pid: ChildProcessSpawner.ProcessId(2147483647),
		exitCode,
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		stdin: Sink.drain,
		stdout: Stream.empty,
		stderr: Stream.empty,
		all: Stream.empty,
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		unref: Effect.succeed(Effect.void),
	})

export const success = Effect.succeed(ChildProcessSpawner.ExitCode(0))
export const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const write = (name: string, text: string) =>
		fs.writeFileString(path.join(directory, name), text)
	const read = (name: string) => fs.readFileString(path.join(directory, name))
	const managerWithSpawner = (
		spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
		filesystem: FileSystem.FileSystem = fs,
	) =>
		make({ directory }).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			Effect.provideService(FileSystem.FileSystem, filesystem),
			Effect.tap((manager) =>
				Effect.addFinalizer(() =>
					manager.recoveryRequired.pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.void,
								onSome: (error) =>
									fs
										.remove(error.snapshotDirectory, {
											recursive: true,
											force: true,
										})
										.pipe(Effect.orDie),
							}),
						),
					),
				),
			),
		)
	const manager = (
		run: (
			command: ChildProcess.Command,
		) => Effect.Effect<
			ChildProcessSpawner.ExitCode,
			PlatformError.PlatformError
		>,
		filesystem: FileSystem.FileSystem = fs,
	) =>
		managerWithSpawner(
			ChildProcessSpawner.make((command) =>
				Effect.succeed(handle(run(command))),
			),
			filesystem,
		)
	return { fs, path, directory, write, read, manager, managerWithSpawner }
})
export const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| FileSystem.FileSystem
		| Path.Path
		| Scope.Scope
		| ChildProcessSpawner.ChildProcessSpawner
	>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

export const closeProcessWithTestClock = Effect.fnUntraced(function* (
	...args: Parameters<typeof closeProcess>
) {
	const fiber = yield* closeProcess(...args).pipe(Effect.forkScoped)
	yield* TestClock.adjust("2 seconds")
	return yield* Fiber.join(fiber)
}, Effect.scoped)
