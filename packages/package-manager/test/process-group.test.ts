import { assert, it } from "@effect/vitest"
import { Array, Cause, Effect, Exit, Option, PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { closeProcessWithTestClock as closeProcess } from "./fixtures.ts"
import { handle, run, setup } from "./fixtures.ts"

it.live(
	"accepts a successful installer whose entire process group has exited",
	() =>
		Effect.gen(function* () {
			const { write, managerWithSpawner } = yield* setup
			yield* write("package.json", "{}")
			const real = yield* ChildProcessSpawner.ChildProcessSpawner
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make((command) => {
					if (command._tag !== "StandardCommand")
						return Effect.die("Unexpected pipeline")
					assert.strictEqual(command.options.detached, true)
					return real.spawn(
						ChildProcess.make(
							"node",
							["-e", "process.exit(0)"],
							command.options,
						),
					)
				}),
			)
			const exit = yield* Effect.exit(pm.install({}))
			assert(
				Exit.isSuccess(exit),
				"An exited process group must not turn installation into a failure",
			)
		}).pipe(run),
)

it.effect(
	"retains kill and probe failures without guessing whether a group is gone",
	() =>
		Effect.gen(function* () {
			const killError = PlatformError.systemError({
				_tag: "Unknown",
				module: "ChildProcess",
				method: "kill",
			})
			const probeError = PlatformError.systemError({
				_tag: "PermissionDenied",
				module: "ChildProcess",
				method: "probeGroup",
			})
			const process = ChildProcessSpawner.makeHandle({
				...handle(Effect.succeed(ChildProcessSpawner.ExitCode(0))),
				kill: () => Effect.fail(killError),
			})
			const absent = yield* Effect.exit(
				closeProcess(process, {}, () => Effect.succeed(false)),
			)
			assert(Exit.isFailure(absent))
			const alive = yield* Effect.exit(
				closeProcess(process, {}, () => Effect.succeed(true)),
			)
			assert(Exit.isFailure(alive))
			assert(
				Array.some(
					alive.cause.reasons,
					(reason) => Cause.isFailReason(reason) && reason.error === killError,
				),
			)
			const unknown = yield* Effect.exit(
				closeProcess(process, {}, () => Effect.fail(probeError)),
			)
			assert(Exit.isFailure(unknown))
			assert(
				Array.some(
					unknown.cause.reasons,
					(reason) => Cause.isFailReason(reason) && reason.error === killError,
				),
			)
			assert(
				Array.some(
					unknown.cause.reasons,
					(reason) => Cause.isFailReason(reason) && reason.error === probeError,
				),
			)
		}),
)

it.live(
	"cleans descendants of an exited leader before restoring the manifest",
	() =>
		Effect.gen(function* () {
			const { write, read, fs, path, directory, managerWithSpawner } =
				yield* setup
			yield* write("package.json", "{}")
			const real = yield* ChildProcessSpawner.ChildProcessSpawner
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make((command) => {
					if (command._tag !== "StandardCommand")
						return Effect.die("Unexpected pipeline")
					return real.spawn(
						ChildProcess.make(
							"node",
							[
								"-e",
								`
    const fs = require("node:fs");
    const child = require("node:child_process").spawn(process.execPath, ["-e", \`
     const fs = require("node:fs");
     process.on("SIGTERM", () => {});
     fs.writeFileSync("ready", "");
     setInterval(() => fs.writeFileSync("package.json", "descendant write"), 20);
     setTimeout(() => { fs.writeFileSync("watchdog", ""); process.exit(0); }, 8000);
    \`], { stdio: "ignore" });
    child.unref();
    setInterval(() => { if (fs.existsSync("ready")) process.exit(1); }, 10);
   `,
							],
							command.options,
						),
					)
				}),
			)
			const exit = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(exit))
			const recovery = yield* pm.recoveryRequired
			assert(
				Option.isNone(recovery),
				"Ordinary descendant cleanup must allow rollback",
			)
			const restored = yield* read("package.json")
			assert.strictEqual(restored, "{}")
			yield* Effect.sleep("150 millis")
			const after = yield* read("package.json")
			const watchdogFired = yield* fs.exists(path.join(directory, "watchdog"))
			assert.strictEqual(after, "{}")
			assert.strictEqual(watchdogFired, false)
		}).pipe(run),
	15000,
)
