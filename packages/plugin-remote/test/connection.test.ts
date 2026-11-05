import process from "node:process"

import { Effect, Exit, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import * as LocalExecution from "../src/internal/host/local"
import * as Local from "../src/internal/runner/Local"

describe("local connection ownership", () => {
	it.live(
		"excludes an intentional process kill from connection diagnostics",
		() =>
			Effect.gen(function* () {
				const scope = yield* Effect.scope
				const resources = yield* Scope.fork(scope)
				const processScope = yield* Scope.fork(scope)
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const child = yield* spawner
					.spawn(
						ChildProcess.make(
							process.execPath,
							["-e", "process.stdin.resume()"],
							{
								stdin: "pipe",
								stdout: "pipe",
								stderr: "pipe",
								additionalFds: { fd3: { type: "output" } },
							},
						),
					)
					.pipe(Scope.provide(processScope))
				const execution = yield* LocalExecution.observe(child)
				const connection = yield* Local.connect(execution, {
					session: "test",
					serve: {},
					call: {},
				}).pipe(Scope.provide(resources))
				yield* connection.terminate(false)
				yield* Scope.close(processScope, Exit.void)
				const cause = yield* connection.diagnostics
				assert.isEmpty(cause.reasons)
				assert.throws(() => process.kill(child.pid, 0))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
