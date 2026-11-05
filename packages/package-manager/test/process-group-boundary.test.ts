import * as NodeProcess from "node:process"

import {
	Effect,
	Exit,
	Option,
	PlatformError,
	Ref,
	Schedule,
	Schema,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { assert, it } from "@effect/vitest"

import { groupExists } from "../src/process.ts"
import { run, setup } from "./fixtures.ts"

it.live(
	"confirms only the original group and does not contain an independent descendant",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory, write, read, managerWithSpawner } =
				yield* setup
			yield* write("package.json", "{}")
			const pidFile = path.join(directory, "child.pid")
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					if (!(yield* fs.exists(pidFile))) return
					const pid = yield* fs
						.readFileString(pidFile)
						.pipe(Effect.flatMap(Schema.decodeEffect(Schema.FiniteFromString)))
					assert(pid > 0)
					yield* Effect.try({
						try: () => NodeProcess.kill(-pid, "SIGKILL"),
						catch: (cause) =>
							PlatformError.systemError({
								_tag: "Unknown",
								module: "ChildProcess",
								method: "kill",
								cause,
							}),
					}).pipe(
						Effect.catchIf(
							(error) =>
								Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))(
									error.cause,
								),
							() => Effect.void,
						),
					)
				}).pipe(Effect.orDie),
			)
			const original = yield* Ref.make(
				Option.none<ChildProcessSpawner.ProcessId>(),
			)
			const real = yield* ChildProcessSpawner.ChildProcessSpawner
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make((command) => {
					if (command._tag !== "StandardCommand")
						return Effect.die("Unexpected pipeline")
					return real
						.spawn(
							ChildProcess.make(
								"node",
								[
									"-e",
									`
        const fs = require("node:fs");
        const child = require("node:child_process").spawn(process.execPath, ["-e", \`
          const fs = require("node:fs");
          fs.writeFileSync("child.ready", "");
          const timer = setInterval(() => {
            if (fs.existsSync("allow-late")) {
              clearInterval(timer);
              fs.writeFileSync("package.json", "late descendant write");
              fs.writeFileSync("late-written", "");
            }
          }, 10);
          setTimeout(() => process.exit(0), 5000);
        \`], { detached: true, stdio: "ignore" });
        fs.writeFileSync("child.pid", String(child.pid));
        child.unref();
        setInterval(() => { if (fs.existsSync("child.ready")) process.exit(1); }, 10);
      `,
								],
								command.options,
							),
						)
						.pipe(
							Effect.tap((handle) =>
								Ref.set(original, Option.some(handle.pid)),
							),
						)
				}),
			)
			const exit = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(exit))
			const pid = yield* Ref.get(original)
			const exists = yield* groupExists(Option.getOrThrow(pid))
			assert.strictEqual(
				exists,
				false,
				"The original process group is stopped before restoration",
			)
			const restored = yield* read("package.json")
			assert.strictEqual(restored, "{}")
			const state = yield* pm.recoveryRequired
			assert(Option.isNone(state))
			// This deliberately violates the support contract to record the containment boundary.
			yield* write("allow-late", "")
			yield* fs.exists(path.join(directory, "late-written")).pipe(
				Effect.repeat({
					until: Boolean,
					schedule: Schedule.spaced("10 millis"),
				}),
				Effect.timeout("2 seconds"),
			)
			const late = yield* read("package.json")
			assert.strictEqual(late, "late descendant write")
		}).pipe(run),
	10000,
)
