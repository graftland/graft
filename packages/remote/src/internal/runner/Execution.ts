import { Command, CommandJson } from "./WatchdogProtocol"
import {
	Array,
	Cause,
	FileSystem,
	Path,
	Schema,
	type PlatformError,
	Exit,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Queue,
	Ref,
	Sink,
	Stream,
	String,
	Layer,
	Schedule,
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
import { SecureRandom } from "effect/crypto"
import { command } from "./command"

export class Channels extends Context.Service<
	Channels,
	{
		readonly peer: (
			token: string,
		) => Effect.Effect<
			Effect.Success<ReturnType<typeof Multiplex.make>>,
			SessionStopped | SessionConflict,
			Scope.Scope
		>
	}
>()("@graftland/remote/internal/runner/Execution/Channels") {}

export const make = (root: string) =>
	Effect.gen(function* () {
		const random = yield* SecureRandom.SecureRandom
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const platform = Context.make(
			ChildProcessSpawner.ChildProcessSpawner,
			spawner,
		).pipe(Context.add(FileSystem.FileSystem, fs), Context.add(Path.Path, path))

		const peers = yield* Ref.make(
			HashMap.empty<
				string,
				Effect.Success<ReturnType<typeof Multiplex.make>>
			>(),
		)
		const claimed = yield* Ref.make(HashSet.empty<string>())
		const driver = Execution.of({
			recover: (child) =>
				Processes.recover(child).pipe(Effect.provideContext(platform)),
			spawn: (handle, request, limits, register) =>
				Effect.gen(function* () {
					const resolved = yield* Packages.resolve(root, request.specifier)
					const nonce = yield* random.uuidV4()
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
									nonce,
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
					const tail = yield* Ref.make("")
					const stdout = yield* child.stdout.pipe(
						Stream.runDrain,
						Effect.forkScoped,
					)
					const stderr = yield* child.stderr.pipe(
						Stream.decodeText(),
						Stream.runForEach((text) =>
							Ref.update(tail, (old) => String.takeRight(old + text, 8192)),
						),
						Effect.forkScoped,
					)
					const exited = yield* Effect.gen(function* () {
						const result = yield* Effect.exit(child.exitCode)
						// exitCode also fails for signals and input errors. isRunning observes Node's exit event.
						yield* child.isRunning.pipe(
							Effect.repeat({
								schedule: Schedule.spaced("25 millis"),
								while: (running) => running,
							}),
						)
						const err = yield* Fiber.await(stderr)
						const out = yield* Fiber.await(stdout)
						return {
							code: result._tag === "Success" ? result.value : null,
							signal: null,
							stderr: yield* Ref.get(tail),
							cause: Array.reduce(
								[Exit.asVoid(result), err, out],
								Cause.empty,
								(cause: Cause.Cause<PlatformError.PlatformError>, exit) =>
									Exit.isFailure(exit)
										? Cause.combine(cause, exit.cause)
										: cause,
							),
						}
					}).pipe(
						Effect.mapError((error) =>
							ExecutionError.make({
								detail: "Observing child exit failed",
								cause: Cause.fail(error),
							}),
						),
						Effect.forkScoped,
					)
					const controls = yield* Queue.bounded<string>(4)
					const writerFailed = yield* Deferred.make<never, ExecutionError>()
					yield* Stream.fromQueue(controls).pipe(
						Stream.map((line) => new TextEncoder().encode(line + "\n")),
						Stream.run(child.getInputFd(4)),
						Effect.mapError((error) =>
							ExecutionError.make({
								detail: "Child supervision channel failed",
								cause: Cause.fail(error),
							}),
						),
						Effect.catchCause((cause) =>
							Deferred.failCause(writerFailed, cause),
						),
						Effect.forkScoped,
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
							Deferred.await(writerFailed),
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
					const identity = yield* Processes.identity(child.pid, nonce)
					yield* Ref.update(peers, HashMap.set(handle.token, peer))
					yield* Effect.addFinalizer(() =>
						Ref.update(peers, HashMap.remove(handle.token)),
					)
					yield* register({
						identity,
						exited: Fiber.join(exited),
						interrupt: send({ kind: "stop" }),
						kill: child.kill({ killSignal: "SIGKILL" }).pipe(
							Effect.mapError((error) =>
								ExecutionError.make({
									detail: "Killing the child failed",
									cause: Cause.fail(error),
								}),
							),
						),
						renew: (millis) => send({ kind: "renew", millis }),
					})
					yield* send({ kind: "start" })
					return resolved.identity
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
												cause: Cause.empty,
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
								cause: Cause.empty,
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
