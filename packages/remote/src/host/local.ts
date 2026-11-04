import { Plugin } from "@graftland/graft"
import { Array, Effect, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { LocalTransport } from "../internal/directTransport"
import { command } from "../internal/runner/command"
import * as Local from "../internal/host/local"

const make = Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
	LocalTransport.of({
		start: Effect.fnUntraced(function* (options) {
			const scope = yield* Effect.scope
			// Readers must outlive the process finalizer to capture its final diagnostics.
			const readers = yield* Scope.fork(scope)
			const argv = yield* command(options.command)
			const child = yield* spawner.spawn(
				ChildProcess.make(
					argv[0],
					[...Array.drop(argv, 1), options.contractModule, options.session],
					{
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
						additionalFds: { fd3: { type: "output" } },
						forceKillAfter: "1 second",
					},
				),
			)
			return yield* Local.observe(child).pipe(Scope.provide(readers))
		}),
	}),
)
const plugin = Plugin.service(LocalTransport, make, {
	name: "remote-local-transport",
	inject: [ChildProcessSpawner.ChildProcessSpawner],
})

export default plugin
