import { SessionError } from "./internal/runner/Wire"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import type { Duration, Schedule, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { SecureRandom } from "effect/crypto"
import { local, runner, type Target } from "./Targets"
export { local, runner }
import * as Connection from "./internal/runner/Connection"
import { RemoteTerminationUnconfirmed } from "./internal/runner/model"
export { SessionError, RemoteTerminationUnconfirmed }
import * as Services from "./internal/services"
import { Instance } from "./Instance"
export { Instance }
import { cleanupCause } from "./internal/cleanup"
import {
	RemoteWithdrawn,
	type ProcessExited,
	type TransportError,
} from "./Errors"
import * as Contract from "./Contract"
import * as Control from "./internal/control"
export { Contract }
export { ProcessExited, TransportError, RemoteWithdrawn } from "./Errors"

export interface Options {
	readonly target?: Target
	readonly instance?: string
	/** Contract module exported as default or named `contract`, resolved in the runner installation. */
	readonly contractModule: string
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
}

/** One owned execution per activation, with explicitly mapped services. */
export const plugin = <
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
>(
	contract: ReturnType<typeof Contract.make<S, E>>,
	options: Options,
): Plugin.Plugin<
	S["Encoded"],
	S["Encoded"],
	| E["Type"]
	| Contract.UndeclaredFailure
	| Schema.SchemaError
	| PlatformError.PlatformError
	| ProcessExited
	| TransportError
	| RpcClientError.RpcClientError
	| Graft.ServiceConflict
	| RemoteWithdrawn
	| SessionError
	| RemoteTerminationUnconfirmed
> =>
	Plugin.make({
		name: contract.name,
		inject: [
			...(options.target?._tag === "Runner"
				? []
				: [ChildProcessSpawner.ChildProcessSpawner]),
			...Array.map(contract.inject, (service) => service.key),
		],
		config: Schema.toEncoded(contract.config),
		retry: options.retry,
		apply: (input) =>
			Effect.gen(function* () {
				const session = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())

				const json = yield* Schema.decodeEffect(Schema.Json)(input)
				yield* Schema.decodeEffect(contract.config)(input)
				// Keep transport fibers alive until the process has exited, including forced cleanup.
				const activationScope = yield* Effect.scope
				const resources = yield* Scope.fork(activationScope)
				const processScope = yield* Scope.fork(activationScope)
				const diagnostics = yield* Ref.make<
					Effect.Effect<Cause.Cause<unknown>>
				>(Effect.succeed(Cause.empty))
				const cleanup = yield* Ref.make<
					Effect.Effect<Exit.Exit<void, unknown>>
				>(Effect.succeed(Exit.void))
				const remoteCleanupCause = yield* Ref.make<Cause.Cause<unknown>>(
					Cause.empty,
				)
				yield* Effect.addFinalizer((exit) =>
					Effect.gen(function* () {
						const finish = yield* Ref.get(cleanup)
						const graceful = yield* finish
						const processClosed = yield* Effect.exit(
							Scope.close(processScope, exit),
						)
						const diagnosticEffect = yield* Ref.get(diagnostics)
						yield* diagnosticEffect
						const closed = yield* Effect.exit(Scope.close(resources, exit))
						const observed = yield* diagnosticEffect
						const remote = yield* Ref.get(remoteCleanupCause)
						const cause = Cause.combine(
							Cause.combine(
								remote,
								Cause.combine(
									observed,
									Exit.isFailure(processClosed)
										? processClosed.cause
										: Cause.empty,
								),
							),
							Cause.combine(
								Exit.isFailure(graceful) ? graceful.cause : Cause.empty,
								Exit.isFailure(closed) ? closed.cause : Cause.empty,
							),
						)
						// Finalizers cannot expose typed errors; preserve each reason at the top level.
						if (cause.reasons.length > 0)
							return yield* Effect.failCause(cleanupCause(cause))
					}),
				)
				const connection = yield* Connection.open(
					options.target ?? local(),
					options.contractModule,
					options.instance,
					{
						session,
						serve: Services.endpoints(contract.inject),
						call: {
							...Services.endpoints(contract.provides),
							[Control.endpoint]: contract.control,
						},
					},
					resources,
					processScope,
				)
				const transport = connection.transport
				yield* Ref.set(diagnostics, connection.diagnostics)

				const client = yield* RpcClient.make(contract.control).pipe(
					Effect.provideService(
						RpcClient.Protocol,
						transport.clientProtocol(Control.endpoint),
					),
					Scope.provide(resources),
				)
				for (const service of contract.inject)
					yield* service
						.serve(transport)
						.pipe(Effect.tapCause(transport.report), Effect.forkIn(resources))
				const race = <A, EX, R>(effect: Effect.Effect<A, EX, R>) =>
					Effect.raceFirst(effect, transport.failure)
				const stopped = yield* Deferred.make<void>()
				const remoteFailure = yield* Deferred.make<
					never,
					E["Type"] | Contract.UndeclaredFailure | RemoteWithdrawn
				>()
				const events = yield* client.Events().pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							if (event._tag === "Stopped") {
								yield* Deferred.succeed(stopped, undefined)
								return
							}
							if (event._tag === "Withdrawing") {
								yield* Deferred.failCause(
									remoteFailure,
									Cause.fail(RemoteWithdrawn.make({})),
								)
								return
							}
							if (event._tag === "Failed") {
								const cause = yield* contract.decodeCause(event.cause)
								yield* Deferred.failCause(remoteFailure, cause)
								return
							}
						}),
					),
					race,
					Effect.tapCause(transport.report),
					Effect.forkIn(resources),
				)
				const logsEnded = yield* Deferred.make<void>()
				const reportedDrops = yield* Ref.make(0)
				yield* client.Logs().pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							const previous = yield* Ref.getAndSet(
								reportedDrops,
								event.dropped,
							)
							if (event.dropped > previous)
								yield* Effect.logWarning("Remote logs were dropped").pipe(
									Effect.annotateLogs({
										"remote.pid": connection.pid,
										"remote.logs.dropped": event.dropped - previous,
										"remote.logs.droppedTotal": event.dropped,
									}),
								)
							if (event._tag === "LogsEnded") {
								yield* Deferred.succeed(logsEnded, undefined)
								return
							}
							const entry = event.entry
							const cause = yield* contract.decodeCause(entry.cause)
							yield* Effect.logWithLevel(
								entry.level === "All" || entry.level === "None"
									? "Info"
									: entry.level,
							)(
								...(Array.isArray(entry.message)
									? entry.message
									: [entry.message]),
								cause,
							).pipe(
								Effect.annotateLogs({
									"remote.pid": connection.pid,
									"remote.annotations": entry.annotations,
								}),
							)
						}),
					),
					race,
					Effect.tapCause(transport.report),
					Effect.forkIn(resources),
				)
				yield* Ref.set(
					cleanup,
					Effect.gen(function* () {
						yield* race(
							client
								.Dispose()
								.pipe(
									Effect.catchIf(Cause.isCause, (cause) =>
										Ref.set(remoteCleanupCause, cause),
									),
								),
						)
						// Control completion never waits behind logs; separately drain the bounded log tail.
						yield* race(Deferred.await(stopped))
						yield* race(Deferred.await(logsEnded))
					}).pipe(
						Effect.interruptible,
						Effect.timeout(options.shutdownTimeout ?? "5 seconds"),
						Effect.exit,
						Effect.flatMap((graceful) =>
							Effect.gen(function* () {
								const terminated = yield* Effect.exit(
									connection.terminate(Exit.isSuccess(graceful)),
								)
								if (Exit.isFailure(graceful) && Exit.isFailure(terminated))
									return Exit.failCause(
										Cause.combine(graceful.cause, terminated.cause),
									)
								return Exit.isFailure(graceful) ? graceful : terminated
							}),
						),
					),
				)
				yield* race(
					Effect.raceFirst(
						client
							.Load({ input: json })
							.pipe(
								Effect.catchIf(
									(
										cause,
									): cause is Cause.Cause<
										E["Type"] | Contract.UndeclaredFailure
									> => Cause.isCause(cause),
									Effect.failCause,
								),
							),
						Deferred.await(remoteFailure),
					),
				)
				for (const service of contract.provides)
					yield* service.publish(transport).pipe(Scope.provide(resources))
				yield* Plugin.fork(
					Effect.raceFirst(Fiber.join(events), Deferred.await(remoteFailure)),
				)
				return () => Effect.succeed(false)
			}),
	})
