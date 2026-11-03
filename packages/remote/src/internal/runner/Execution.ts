import {
	Cause,
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
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TransportError } from "../../Errors"
import * as Multiplex from "./Multiplex"
import * as Packages from "./Packages"
import * as Processes from "./Processes"
import { Execution, failure, type Handle, type Limits } from "./model"
import { Bootstrap } from "./Bootstrap"
import { FileSystem, Path, Schema, Array } from "effect"
import { SecureRandom } from "effect/crypto"
import { command } from "./command"

export const make = (
	root: string,
	settings: (
		handle: Handle,
	) => Effect.Effect<Limits, ReturnType<typeof failure>>,
) =>
	Effect.gen(function* () {
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
			spawn: (handle, request, register) =>
				Effect.gen(function* () {
					const resolved = yield* Packages.resolve(root, request.specifier)
					const limits = yield* settings(handle)
					const nonce = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())
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
						while (yield* child.isRunning) yield* Effect.sleep("25 millis")
						const err = yield* Fiber.await(stderr)
						const out = yield* Fiber.await(stdout)
						return {
							code: result._tag === "Success" ? result.value : null,
							signal: null,
							stderr: yield* Ref.get(tail),
							cause: Array.reduce(
								[Exit.asVoid(result), err, out],
								Cause.empty as Cause.Cause<unknown>,
								(cause, exit) =>
									Exit.isFailure(exit)
										? Cause.combine(cause, exit.cause)
										: cause,
							),
						}
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.fail(
								failure("Execution", "Observing child exit failed", cause),
							),
						),
						Effect.forkScoped,
					)
					const controls = yield* Queue.bounded<string>(4)
					const writerFailed = yield* Deferred.make<
						never,
						ReturnType<typeof failure>
					>()
					yield* Stream.fromQueue(controls).pipe(
						Stream.map((line) => new TextEncoder().encode(line + "\n")),
						Stream.run(child.getInputFd(4)),
						Effect.catchCause((cause) =>
							Deferred.fail(
								writerFailed,
								failure("Execution", "Child supervision channel failed", cause),
							),
						),
						Effect.forkScoped,
					)
					const send = (
						value:
							| { readonly kind: "renew"; readonly millis: number }
							| { readonly kind: "start" | "stop" },
					) =>
						Effect.raceFirst(
							Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
								value,
							).pipe(
								Effect.flatMap((line) => Queue.offer(controls, line)),
								Effect.asVoid,
								Effect.catchCause((cause) =>
									Effect.fail(
										failure(
											"Execution",
											"Encoding watchdog command failed",
											cause,
										),
									),
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
						kill: child
							.kill({ killSignal: "SIGKILL" })
							.pipe(
								Effect.catchCause((cause) =>
									Effect.fail(
										failure("Execution", "Killing the child failed", cause),
									),
								),
							),
						renew: (millis) => send({ kind: "renew", millis }),
					})
					yield* send({ kind: "start" })
					return resolved.identity
				}).pipe(
					Effect.provideContext(platform),
					Effect.catchCause((cause) =>
						Effect.fail(
							failure("Execution", "Starting the child failed", cause),
						),
					),
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
											failure(
												"Stopped",
												"The execution channel is no longer available",
											),
										)
							}),
						)
						const occupied = yield* Ref.modify(
							claimed,
							(all) =>
								[HashSet.has(all, token), HashSet.add(all, token)] as const,
						)
						if (occupied)
							return yield* failure(
								"Conflict",
								"The instance channel is already attached",
							)
						return peer
					}),
					() => Ref.update(claimed, HashSet.remove(token)),
				),
		}
	})
