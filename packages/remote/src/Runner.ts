import { Graft, Plugin } from "@graftland/graft"
import { NodeServices, NodeSink } from "@effect/platform-node"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Option,
	Queue,
	Ref,
	Scope,
	PlatformError,
	References,
	Stdio,
	Stream,
} from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's extra inherited descriptor is the dedicated protocol output, separate from console output.
import { createWriteStream } from "node:fs"
import { UndeclaredFailure, type RunnerContract } from "./Contract"
import { Control, type Event } from "./internal/control"

/** Run from an executable bootstrap; importing this module performs no I/O. */
export const run = (contract: RunnerContract) =>
	Effect.scoped(
		Effect.gen(function* () {
			const eof = yield* Deferred.make<void>()
			const events =
				yield* Queue.unbounded<Effect.Effect<typeof Event.Type, never>>()
			const instance = yield* Ref.make(
				Option.none<Effect.Effect<void, unknown>>(),
			)
			const instanceScope = yield* Scope.make()
			yield* Effect.addFinalizer((exit) => Scope.close(instanceScope, exit))
			const encode = (cause: Cause.Cause<unknown>) =>
				contract.encodeCause(cause).pipe(Effect.orDie)
			const logger = Logger.make((entry) => {
				const annotations = entry.fiber.getRef(References.CurrentLogAnnotations)
				Queue.offerUnsafe(
					events,
					Effect.map(encode(entry.cause), (cause) => ({
						_tag: "Log",
						entry: {
							level: entry.logLevel,
							message: entry.message,
							cause,
							annotations,
						},
					})),
				)
			})
			return yield* Effect.gen(function* () {
				const handlers = Control.toLayer({
					Load: ({ input }) =>
						Effect.gen(function* () {
							const current = yield* Ref.get(instance)
							if (Option.isSome(current))
								return yield* Effect.die(
									new Error("This runner already owns an instance"),
								)
							const module = yield* Effect.tryPromise({
								try: () => import(contract.module),
								catch: (cause) => UndeclaredFailure.make({ original: cause }),
							}).pipe(Effect.orDie)
							const plugin = Plugin.fromModule(module)
							if (Option.isNone(plugin))
								return yield* Effect.die(
									new Error("The implementation module exports no plugin"),
								)
							const fork = yield* Graft.plugin(
								{ ...plugin.value, retry: undefined },
								input,
							).pipe(Scope.provide(instanceScope))
							yield* Ref.set(
								instance,
								Option.some(
									fork.dispose.pipe(
										Effect.catchTag("CleanupError", (error) =>
											// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Dynamic plugin cleanup is encoded without discarding its cause.
											Effect.failCause(error.cause),
										),
									),
								),
							)
							const first = yield* Stream.runHead(
								fork.state.pipe(
									Stream.filter((state) => state._tag !== "Loading"),
								),
							)
							if (Option.isNone(first))
								return yield* Effect.die(
									new Error("The remote fork disappeared during startup"),
								)
							const state = first.value
							if (state._tag === "Failed")
								return {
									_tag: "Failure",
									cause: yield* encode(state.cause),
								} as const
							if (state._tag !== "Active")
								return yield* Effect.die(
									new Error(
										"The remote plugin did not become active; cross-process dependencies are not supported",
									),
								)
							yield* fork.state.pipe(
								Stream.runForEach((state) =>
									state._tag === "Failed"
										? Queue.offer(
												events,
												Effect.map(encode(state.cause), (cause) => ({
													_tag: "Failed",
													cause,
												})),
											)
										: Effect.void,
								),
								Effect.forkIn(instanceScope),
							)
							return { _tag: "Success" } as const
						}),
					Events: () =>
						Stream.fromQueue(events).pipe(Stream.mapEffect((event) => event)),
					Dispose: () =>
						Effect.gen(function* () {
							const current = yield* Ref.get(instance)
							const exit = yield* Effect.exit(
								// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Dynamic plugin cleanup is observed as an Exit for wire encoding.
								Option.isSome(current) ? current.value : Effect.void,
							)
							yield* Queue.offer(events, Effect.succeed({ _tag: "Stopped" }))
							return Exit.isFailure(exit)
								? ({
										_tag: "Failure",
										cause: yield* encode(exit.cause),
									} as const)
								: ({ _tag: "Success" } as const)
						}),
				})
				const stdio = yield* Stdio.Stdio
				const output = yield* Effect.sync(() =>
					createWriteStream("", { fd: 3, autoClose: false }),
				)
				const protocolStdio = Stdio.make({
					args: stdio.args,
					stdin: stdio.stdin.pipe(
						Stream.ensuring(Deferred.succeed(eof, undefined)),
					),
					stdout: () =>
						NodeSink.fromWritable({
							evaluate: () => output,
							onError: (cause) =>
								PlatformError.systemError({
									_tag: "Unknown",
									module: "Remote",
									method: "write",
									cause,
								}),
							endOnDone: false,
						}),
					stderr: stdio.stderr,
				})
				// Stdio's writer finalizer interrupts its construction fiber. Give that fiber
				// its own scope so normal protocol shutdown cannot interrupt the runner root.
				const ready = yield* Deferred.make<RpcServer.Protocol["Service"]>()
				const owner = yield* Effect.gen(function* () {
					const protocol = yield* RpcServer.makeProtocolStdio.pipe(
						Effect.provideService(Stdio.Stdio, protocolStdio),
						Effect.provideService(
							RpcSerialization.RpcSerialization,
							RpcSerialization.ndjson,
						),
					)
					yield* Deferred.succeed(ready, protocol)
					return yield* Effect.never
				}).pipe(Effect.forkScoped)
				const protocol = yield* Effect.raceFirst(
					Deferred.await(ready),
					Fiber.join(owner),
				)
				const server = RpcServer.layer(Control, {
					disableFatalDefects: true,
				}).pipe(
					Layer.provide(handlers),
					Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
				)
				yield* Effect.raceFirst(Deferred.await(eof), Fiber.join(owner)).pipe(
					// @effect-diagnostics-next-line strictEffectProvide:off -- This executable runner entry point owns the RPC server and its logger until stdin closes.
					Effect.provide(server),
				)
			}).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off -- Both the protocol reader and plugin handlers must inherit the runner's event logger.
				Effect.provide(Logger.layer([logger], { mergeWithExisting: true })),
			)
		}),
	).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- The runner entry point owns its Graft runtime and Node services.
		Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
	)
