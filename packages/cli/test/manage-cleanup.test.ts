import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Array,
	String as Str,
	Effect,
	FileSystem,
	Logger,
	Option,
	Path,
	PlatformError,
	Sink,
	Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import * as Manage from "../src/Manage.ts"

it.effect(
	"reports retained snapshot cleanup without failing a committed installation",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const directory = yield* fs.makeTempDirectoryScoped()
			const marker = PlatformError.systemError({
				_tag: "PermissionDenied",
				module: "FileSystem",
				method: "remove",
			})
			const logs: Array<Logger.Options<unknown>> = []
			const handle = ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(2147483647),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
			yield* Manage.create({
				directory: path.join(directory, "app"),
				name: Option.some("example"),
				install: true,
			}).pipe(
				Effect.provideService(
					ChildProcessSpawner.ChildProcessSpawner,
					ChildProcessSpawner.make(() => Effect.succeed(handle)),
				),
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					makeTempDirectory: () =>
						fs.makeTempDirectory({ directory, prefix: "snapshot-" }),
					remove: (file, options) =>
						Str.startsWith("snapshot-")(path.basename(file))
							? Effect.fail(marker)
							: fs.remove(file, options),
				}),
				Effect.provide(
					Logger.layer([
						Logger.make((entry) => {
							logs.push(entry)
						}),
					]),
				),
			)
			const warning = Array.findFirst(logs, (log) =>
				Array.some(
					log.cause.reasons,
					(reason) => reason._tag === "Fail" && reason.error === marker,
				),
			)
			assert.isTrue(Option.isSome(warning))
			const names = yield* fs.readDirectory(directory)
			const retained = Array.filter(names, Str.startsWith("snapshot-"))
			assert.strictEqual(retained.length, 1)
			for (const snapshot of retained)
				assert.isTrue(
					Array.some(logs, (log) =>
						Array.some(
							Array.ensure(log.message),
							(message) =>
								typeof message === "object" &&
								message !== null &&
								"snapshotDirectory" in message &&
								message.snapshotDirectory === path.join(directory, snapshot),
						),
					),
				)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
