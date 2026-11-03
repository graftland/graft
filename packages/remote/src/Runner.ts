import { Graft, Plugin } from "@graftland/graft"
import { NodeServices, NodeSink } from "@effect/platform-node"
import {
	Cause,
	Context,
	Array,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	MutableRef,
	Option,
	Queue,
	Ref,
	Scope,
	References,
	Stdio,
	Stream,
} from "effect"
import { RpcClient, RpcGroup, RpcServer } from "effect/rpc"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's extra inherited descriptor is the dedicated protocol output, separate from console output.
import { createWriteStream } from "node:fs"
import { UndeclaredFailure, fromModule, type RunnerContract } from "./Contract"
import { TransportError } from "./Errors"
import { Instance } from "./Instance"
import * as Duplex from "./internal/duplex"
import * as Services from "./internal/services"
import { Control, type Event, type Log } from "./internal/control"

/** Import a contract in the runner installation; importing this module performs no I/O. */
export const load = (specifier: string) =>
	Effect.gen(function* () {
		const module = yield* Effect.tryPromise({
			try: () => import(specifier),
			catch: (cause) => UndeclaredFailure.make({ original: cause }),
		})
		const contract = fromModule(module)
		if (Option.isNone(contract))
			return yield* Effect.die(
				new Error(`No remote contract exported by ${specifier}`),
			)
		return contract.value
	})

/** One local execution unit, owned by the executable's scope. */
export const run = (contract: RunnerContract, session = "local") =>
	Effect.scoped(
		Effect.gen(function* () {
			const releaseExports = yield* Deferred.make<void>()
			const hostDisposing = yield* Ref.make(false)
			const withdrawing = yield* Ref.make(false)
			const exportsReady = yield* Deferred.make<Context.Context<never>>()
			const events =
				yield* Queue.bounded<Effect.Effect<typeof Event.Type, never>>(2)
			const logs = yield* Queue.dropping<
				Effect.Effect<typeof Log.Type>,
				Cause.Done
			>(128)
			// Logger callbacks are synchronous, so the loss counter uses MutableRef.
			const dropped = MutableRef.make(0)
			const instance = yield* Ref.make(
				Option.none<Effect.Effect<void, unknown>>(),
			)
			const scope = yield* Effect.scope
			const instanceScope = yield* Scope.fork(scope)
			const encode = (cause: Cause.Cause<unknown>) =>
				contract.encodeCause(cause).pipe(Effect.orDie)
			const logger = Logger.make((entry) => {
				const annotations = entry.fiber.getRef(References.CurrentLogAnnotations)
				const accepted = Queue.offerUnsafe(
					logs,
					Effect.map(encode(entry.cause), (cause) => ({
						level: entry.logLevel,
						message: entry.message,
						cause,
						annotations,
					})),
				)
				if (!accepted) MutableRef.increment(dropped)
			})
			return yield* Effect.gen(function* () {
				const stdio = yield* Stdio.Stdio
				const output = yield* Effect.sync(() =>
					createWriteStream("", { fd: 3, autoClose: false }),
				)
				const localGroup = Services.combine(Control, contract.provides)
				const remoteGroup = Services.combine(RpcGroup.make(), contract.inject)
				const peer = yield* Duplex.make(
					{
						input: stdio.stdin.pipe(
							Stream.mapError((error) =>
								TransportError.make({ cause: Cause.fail(error) }),
							),
						),
						output: NodeSink.fromWritable({
							evaluate: () => output,
							onError: (cause) =>
								TransportError.make({ cause: Cause.die(cause) }),
							endOnDone: false,
						}),
					},
					{ session, local: localGroup, remote: remoteGroup },
				)
				const client = yield* RpcClient.make(remoteGroup).pipe(
					Effect.provideService(RpcClient.Protocol, peer.clientProtocol),
				)
				const handlers = Control.toLayer({
					Load: ({ input, instance: identity }) =>
						Effect.gen(function* () {
							const current = yield* Ref.get(instance)
							if (Option.isSome(current))
								return yield* Effect.die(
									new Error("This runner already owns an instance"),
								)
							for (const service of contract.inject)
								yield* service.publish(client).pipe(Effect.orDie)
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
							).pipe(
								Effect.provideService(Instance, identity),
								Scope.provide(instanceScope),
							)
							const observedFailure = yield* Ref.make<Cause.Cause<unknown>>(
								Cause.empty,
							)
							const observation = yield* fork.state.pipe(
								Stream.runForEach((state) =>
									state._tag === "Failed"
										? Ref.set(observedFailure, state.cause)
										: Effect.void,
								),
								Effect.forkIn(instanceScope),
							)
							const bridge = yield* Graft.plugin(
								Plugin.make({
									name: `${contract.name}/exports`,
									inject: Array.map(
										contract.provides,
										(service) => service.key,
									),
									apply: () =>
										Effect.gen(function* () {
											const context = yield* Effect.context<never>()
											const bound = yield* Services.handlers(
												contract.provides,
												context,
											)
											yield* Deferred.succeed(exportsReady, bound)
											yield* Effect.addFinalizer(() =>
												Effect.gen(function* () {
													if (!(yield* Ref.get(hostDisposing))) {
														yield* Ref.set(withdrawing, true)
														yield* Queue.offer(
															events,
															Effect.succeed({ _tag: "Withdrawing" }),
														)
													}
													yield* Deferred.await(releaseExports)
												}),
											)
										}),
								}),
							).pipe(Scope.provide(instanceScope))
							yield* Ref.set(
								instance,
								Option.some(
									Effect.gen(function* () {
										const pluginExit = yield* Effect.exit(fork.dispose)
										const bridgeExit = yield* Effect.exit(bridge.dispose)
										yield* Fiber.join(observation)
										const failed = yield* Ref.get(observedFailure)
										const retired = yield* Ref.get(withdrawing)
										const cause = Array.reduce(
											[bridgeExit, pluginExit],
											retired ? failed : (Cause.empty as Cause.Cause<unknown>),
											(cause, exit) =>
												Exit.isFailure(exit)
													? Cause.combine(
															cause,
															Cause.fromReasons(
																Array.flatMap(exit.cause.reasons, (reason) =>
																	reason._tag === "Fail"
																		? reason.error.cause.reasons
																		: [reason],
																),
															),
														)
													: cause,
										)
										if (cause.reasons.length > 0)
											// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Dynamic plugin cleanup is encoded with its complete cause.
											return yield* Effect.failCause(cause)
									}),
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
										"The remote plugin did not become active; check its declared dependencies",
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
							const exported = yield* bridge.state.pipe(
								Stream.filter(
									(state) =>
										state._tag === "Active" ||
										state._tag === "Failed" ||
										state._tag === "Disposed",
								),
								Stream.runHead,
							)
							if (Option.isSome(exported) && exported.value._tag === "Failed")
								return yield* Effect.failCause(exported.value.cause).pipe(
									Effect.orDie,
								)
							if (Option.isNone(exported) || exported.value._tag !== "Active")
								return yield* Effect.die(
									new Error("The remote export bridge stopped during startup"),
								)
							yield* Deferred.await(exportsReady)
							return { _tag: "Success" } as const
						}),
					Events: () =>
						Stream.fromQueue(events).pipe(Stream.mapEffect((event) => event)),
					Logs: () =>
						Stream.fromQueue(logs).pipe(
							Stream.mapEffect((entry) =>
								Effect.map(entry, (entry) => ({
									_tag: "Log" as const,
									entry,
									dropped: MutableRef.get(dropped),
								})),
							),
							Stream.concat(
								Stream.sync(() => ({
									_tag: "LogsEnded" as const,
									dropped: MutableRef.get(dropped),
								})),
							),
						),
					Dispose: () =>
						Effect.gen(function* () {
							yield* Ref.set(hostDisposing, true)
							yield* Deferred.succeed(releaseExports, undefined)
							const current = yield* Ref.get(instance)
							const exit = yield* Effect.exit(
								// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Dynamic plugin cleanup is observed as an Exit for wire encoding.
								Option.isSome(current) ? current.value : Effect.void,
							)
							yield* Queue.offer(events, Effect.succeed({ _tag: "Stopped" }))
							yield* Queue.end(logs)
							return Exit.isFailure(exit)
								? ({
										_tag: "Failure",
										cause: yield* encode(exit.cause),
									} as const)
								: ({ _tag: "Success" } as const)
						}),
				})
				const server = RpcServer.layer(localGroup, {
					disableFatalDefects: true,
				}).pipe(
					Layer.provide(handlers),
					Layer.provide(
						Services.layer(
							Services.deferredHandlers(
								contract.provides,
								Deferred.await(exportsReady),
							),
						),
					),
					Layer.provide(Layer.succeed(RpcServer.Protocol, peer.serverProtocol)),
				)
				yield* Effect.flip(Deferred.await(peer.failed)).pipe(
					// @effect-diagnostics-next-line strictEffectProvide:off -- This runner owns the server until its channel closes.
					Effect.provide(server),
				)
				yield* Ref.set(hostDisposing, true)
				yield* Deferred.succeed(releaseExports, undefined)
			}).pipe(
				// @effect-diagnostics-next-line strictEffectProvide:off -- Both the protocol reader and plugin handlers must inherit the runner's event logger.
				Effect.provide(Logger.layer([logger], { mergeWithExisting: true })),
			)
		}),
	).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- The runner entry point owns its Graft runtime and Node services.
		Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
	)
