import {
	Array,
	Cause,
	Effect,
	Option,
	Path,
	Schema,
	Scope,
	Sink,
	Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"

import { TransportError } from "../Errors"
import { cleanupCause } from "../internal/cleanup"
import * as ProcessObservation from "../internal/runner/ProcessObservation"
import type { CommandOptions } from "../internal/transportOptions"
import { Connector } from "../Transport"

/** Options for the command connector. */
export type { CommandOptions as Options } from "../internal/transportOptions"

export class CommandExited extends Schema.TaggedError<
	CommandExited,
	{ readonly brand: unique symbol }
>()("CommandExited", {
	code: Schema.NullOr(Schema.Int),
	stderr: Schema.String,
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

/** The launcher exit describes this channel, never the remote execution's termination. */
export const make = (options: CommandOptions) =>
	Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
		Connector.of({
			properties: {
				protocol: "command",
				encrypted: false,
				network: false,
				carries: [],
			},
			connect: Effect.fnUntraced(
				function* () {
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
							Effect.catchCause((cause) =>
								Effect.failCause(cleanupCause(cause)),
							),
						),
					)
					return {
						input: child.stdout.pipe(
							Stream.concat(
								Stream.fromEffect(
									exited.pipe(
										Effect.flatMap((status) =>
											status.code === 0 && status.cause.reasons.length === 0
												? Effect.void
												: Effect.fail(status),
										),
									),
								).pipe(Stream.drain),
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
export const Config = Schema.Struct({
	argv: Schema.NonEmptyArray(Schema.String),
	cwd: Schema.optionalKey(Schema.String),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
export default Plugin.make({
	name: "remote-command-connector",
	config: Config,
	inject: [ChildProcessSpawner.ChildProcessSpawner, Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const path = yield* Path.Path
		const directory = yield* ConfigDirectory
		const connector = yield* make({
			...config,
			...(config.cwd === undefined
				? {}
				: {
						cwd: path.resolve(
							Option.getOrElse(directory, () => "."),
							config.cwd,
						),
					}),
		})
		yield* Graft.provide(Connector, connector)
	}),
})
