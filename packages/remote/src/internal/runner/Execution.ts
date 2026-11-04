import * as ProcessObservation from "./ProcessObservation"
import * as FailureGroup from "../FailureGroup"
import { Command, CommandJson } from "./WatchdogProtocol"
import {
	Array,
	Cause,
	FileSystem,
	Path,
	Schema,
	Context,
	Effect,
	HashMap,
	HashSet,
	Queue,
	Ref,
	Sink,
	Stream,
	Layer,
	Scope,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TransportError } from "../../Errors"
import * as Multiplex from "./Multiplex"
import * as Packages from "./Packages"
import * as Processes from "./Processes"
import {
	Execution,
	ExecutionError,
	SessionConflict,
	SessionStopped,
} from "./model"
import { Bootstrap } from "./Bootstrap"
import { command } from "./command"

export class Channels extends Context.Service<
	Channels,
	{
		readonly peer: (
			token: string,
		) => Effect.Effect<
			Multiplex.Peer,
			SessionStopped | SessionConflict,
			Scope.Scope
		>
	}
>()("@graftland/plugin-remote/internal/runner/Execution/Channels") {}

export const make = (root: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const platform = Context.make(
			ChildProcessSpawner.ChildProcessSpawner,
			spawner,
		).pipe(Context.add(FileSystem.FileSystem, fs), Context.add(Path.Path, path))

		const peers = yield* Ref.make(HashMap.empty<string, Multiplex.Peer>())
		const claimed = yield* Ref.make(HashSet.empty<string>())
		const driver = Execution.of({
			recover: (child) =>
				Processes.recover(child).pipe(Effect.provideContext(platform)),
			spawn: (handle, request, limits) =>
				Effect.gen(function* () {
					const resolved = yield* Packages.resolve(
						root,
						request.specifier,
						request.digest,
					)
					const argv = yield* command()
					const child = yield* spawner.spawn(
						ChildProcess.make(
							argv[0],
							[
								...Array.drop(argv, 1),
								"child",
								resolved.entry,
								handle.token,
								yield* Schema.encodeEffect(Schema.fromJsonString(Bootstrap))({
									identity: {
										id: handle.key.instance,
										generation: handle.generation,
									},
									limits,
								}),
							],
							{
								stdin: "pipe",
								stdout: "pipe",
								stderr: "pipe",
								additionalFds: {
									fd3: { type: "output" },
									fd4: { type: "input" },
								},
								forceKillAfter: "1 second",
							},
						),
					)
					const observation = yield* ProcessObservation.observe(child)
					const exited = observation.exited.pipe(
						Effect.mapError((error) =>
							ExecutionError.make({
								detail: "Observing child exit failed",
								cause: Cause.fail(error),
							}),
						),
					)
					const failures = yield* FailureGroup.make<ExecutionError>()
					yield* failures.run(
						observation.failure.pipe(
							Effect.mapError((error) =>
								ExecutionError.make({
									detail: "Reading child output failed",
									cause: Cause.fail(error),
								}),
							),
						),
					)
					const controls = yield* Queue.bounded<string>(4)

					yield* failures.run(
						Stream.fromQueue(controls).pipe(
							Stream.map((line) => new TextEncoder().encode(line + "\n")),
							Stream.run(child.getInputFd(4)),
							Effect.mapError((error) =>
								ExecutionError.make({
									detail: "Child supervision channel failed",
									cause: Cause.fail(error),
								}),
							),
						),
					)
					const send = (value: typeof Command.Type) =>
						Effect.raceFirst(
							Schema.encodeEffect(CommandJson)(value).pipe(
								Effect.flatMap((line) => Queue.offer(controls, line)),
								Effect.asVoid,
								Effect.mapError((error) =>
									ExecutionError.make({
										detail: "Encoding watchdog command failed",
										cause: Cause.fail(error),
									}),
								),
							),
							failures.await,
						)
					const peer = yield* Multiplex.make({
						input: child
							.getOutputFd(3)
							.pipe(
								Stream.mapError((error) =>
									TransportError.make({ cause: Cause.fail(error) }),
								),
							),
						output: child.stdin.pipe(
							Sink.mapError((error) =>
								TransportError.make({ cause: Cause.fail(error) }),
							),
						),
					})
					const identity = yield* Processes.identity(child.pid)
					yield* Ref.update(peers, HashMap.set(handle.token, peer))
					yield* Effect.addFinalizer(() =>
						Ref.update(peers, HashMap.remove(handle.token)),
					)
					return {
						code: resolved.identity,
						start: send({ kind: "start" }),
						identity,
						exited,
						interrupt: send({ kind: "stop" }),
						kill: child.kill({ killSignal: "SIGKILL" }).pipe(
							Effect.mapError((error) =>
								ExecutionError.make({
									detail: "Killing the child failed",
									cause: Cause.fail(error),
								}),
							),
						),
						renew: (millis: number) => send({ kind: "renew", millis }),
					}
				}).pipe(
					Effect.provideContext(platform),
					Effect.catchTags({
						PlatformError: (error) =>
							Effect.fail(
								ExecutionError.make({
									detail: "Starting the child failed",
									cause: Cause.fail(error),
								}),
							),
						SchemaError: (error) =>
							Effect.fail(
								ExecutionError.make({
									detail: "Encoding child bootstrap failed",
									cause: Cause.fail(error),
								}),
							),
					}),
				),
		})
		return {
			driver,
			peer: (token: string) =>
				Effect.acquireRelease(
					Effect.gen(function* () {
						const peer = yield* Ref.get(peers).pipe(
							Effect.flatMap((all) => {
								const peer = HashMap.get(all, token)
								return peer._tag === "Some"
									? Effect.succeed(peer.value)
									: Effect.fail(
											SessionStopped.make({
												detail: "The execution channel is no longer available",
											}),
										)
							}),
						)
						const occupied = yield* Ref.modify(
							claimed,
							(all) =>
								[HashSet.has(all, token), HashSet.add(all, token)] as const,
						)
						if (occupied)
							return yield* SessionConflict.make({
								detail: "The instance channel is already attached",
							})
						return peer
					}),
					() => Ref.update(claimed, HashSet.remove(token)),
				),
		}
	})

export const layer = (root: string) =>
	Layer.effectContext(
		make(root).pipe(
			Effect.map((execution) =>
				Context.make(Execution, execution.driver).pipe(
					Context.add(Channels, { peer: execution.peer }),
				),
			),
		),
	)
