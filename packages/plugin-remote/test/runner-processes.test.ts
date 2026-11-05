import process from "node:process"

import { Array, Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import * as Processes from "../src/internal/runner/Processes"

describe("runner process identity", () => {
	it.effect(
		"continues observing exit when the OS has already discarded argv",
		() =>
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const born = "Wed Nov  4 06:00:00 2026"
				// Replay the recorded identity and the macOS exit snapshots that used to fail the lease test.
				const identity = { pid: 42, start: { born, nonce: "bootstrap-nonce" } }
				for (const status of ["?Es", "Z"]) {
					const observer = ChildProcessSpawner.make((command) => {
						const argv =
							command._tag === "StandardCommand" &&
							Array.contains(command.args, "command=")
						const output = `${born} ${status}${argv ? " (node)" : ""}\n`
						return spawner.spawn(
							ChildProcess.make(process.execPath, [
								"-e",
								"process.stdout.write(process.argv[1])",
								"--",
								output,
							]),
						)
					})
					const alive = yield* Processes.matches(identity).pipe(
						Effect.provideService(
							ChildProcessSpawner.ChildProcessSpawner,
							observer,
						),
					)
					assert.equal(alive, status !== "Z")
				}
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
