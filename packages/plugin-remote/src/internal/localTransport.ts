import { Array, Effect, Layer, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { LocalTransport } from "./directTransport"
import * as Local from "./host/local"
import { command } from "./runner/command"

export const make = Effect.map(
	ChildProcessSpawner.ChildProcessSpawner,
	(spawner) =>
		LocalTransport.of({
			start: Effect.fnUntraced(function* (options, onSpawn) {
				const scope = yield* Effect.scope
				// Readers must outlive the process finalizer to capture its final diagnostics.
				const readers = yield* Scope.fork(scope)
				const argv = yield* command(options.command)
				const child = yield* spawner.spawn(
					ChildProcess.make(
						argv[0],
						[
							...Array.drop(argv, 1),
							options.contractModule,
							options.implementation,
							options.session,
						],
						{
							stdin: "pipe",
							stdout: "pipe",
							stderr: "pipe",
							additionalFds: { fd3: { type: "output" } },
							forceKillAfter: "1 second",
						},
					),
				)
				yield* onSpawn ?? Effect.void
				return yield* Local.observe(child).pipe(Scope.provide(readers))
			}, Effect.uninterruptible),
		}),
)
export const layer = Layer.effect(LocalTransport, make)
