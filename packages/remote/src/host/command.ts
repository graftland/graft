import { Plugin, type Graft } from "@graftland/graft"
import { Array, Cause, Effect, Schema, Scope, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { CommandTransport } from "../Transport"
import { TransportError } from "../Errors"
import { cleanupCause } from "../internal/cleanup"
import * as ProcessObservation from "../internal/runner/ProcessObservation"

export class CommandExited extends Schema.TaggedError<
	CommandExited,
	{ readonly brand: unique symbol }
>()("CommandExited", {
	code: Schema.NullOr(Schema.Int),
	stderr: Schema.String,
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

/** The launcher exit describes this channel, never the remote execution's termination. */
const make = Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
	CommandTransport.of({
		connect: Effect.fnUntraced(
			function* (options) {
				const scope = yield* Effect.scope
				const readers = yield* Scope.fork(scope)
				const child = yield* spawner.spawn(
					ChildProcess.make(options.argv[0], Array.drop(options.argv, 1), {
						...options,
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
						forceKillAfter: "1 second",
					}),
				)
				const observation = yield* ProcessObservation.observe(child, {
					drainStdout: false,
				}).pipe(Scope.provide(readers))
				const exited = observation.exited.pipe(
					Effect.map((status) => CommandExited.make(status)),
				)
				yield* Effect.addFinalizer(() =>
					Stream.empty.pipe(
						Stream.run(child.stdin),
						Effect.andThen(exited),
						Effect.flatMap((status) =>
							status.code === 0 && status.cause.reasons.length === 0
								? Effect.void
								: Effect.fail(status),
						),
						Effect.interruptible,
						Effect.timeout(ProcessObservation.stdinExitTimeout),
						Effect.catchCause((cause) => Effect.failCause(cleanupCause(cause))),
					),
				)
				return {
					input: child.stdout.pipe(
						Stream.concat(
							Stream.fromEffect(exited.pipe(Effect.flatMap(Effect.fail))),
						),
						Stream.interruptWhen(observation.failure),
						Stream.mapError((error) =>
							TransportError.make({ cause: Cause.fail(error) }),
						),
					),
					output: child.stdin.pipe(
						Sink.mapError((error) =>
							TransportError.make({ cause: Cause.fail(error) }),
						),
					),
				}
			},
			Effect.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
	}),
)
const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	CommandTransport,
	make,
	{
		name: "remote-command-transport",
		inject: [ChildProcessSpawner.ChildProcessSpawner],
	},
)
export default plugin
