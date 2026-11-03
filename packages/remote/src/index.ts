import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Context,
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
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
	RpcClient,
	RpcGroup,
	RpcServer,
	type RpcClientError,
	type Rpc,
} from "effect/rpc"
import { SecureRandom } from "effect/crypto"
import process from "node:process"
import * as Services from "./internal/services"
import { Instance } from "./Instance"
export { Instance }
import { fileURLToPath } from "node:url"
import { cleanupCause } from "./internal/cleanup"
import {
	RemoteWithdrawn,
	type ProcessExited,
	type TransportError,
} from "./Errors"
import * as Contract from "./Contract"
import { Control } from "./internal/control"
import * as Transport from "./internal/transport"
export { Contract }
export { ProcessExited, TransportError, RemoteWithdrawn } from "./Errors"

export interface Options {
	/** Contract module exported as default or named `contract`, resolved in the runner installation. */
	readonly contractModule: string
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
}

/** Prototype: one fresh local process for every activation, with explicitly mapped services. */
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
> =>
	Plugin.make({
		name: contract.name,
		inject: [
			ChildProcessSpawner.ChildProcessSpawner,
			...Array.map(contract.inject, (service) => service.key),
		],
		config: Schema.toEncoded(contract.config),
		retry: options.retry,
		apply: (input) =>
			Effect.gen(function* () {
				const session = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())
				const localGroup = Services.combine(RpcGroup.make(), contract.inject)
				const remoteGroup = Services.combine(Control, contract.provides)
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
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const child = yield* spawner
					.spawn(
						ChildProcess.make(
							process.execPath,
							[
								fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
								options.contractModule,
								session,
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
					.pipe(Scope.provide(processScope))
				const transport = yield* Transport.make(child, {
					session,
					local: localGroup,
					remote: remoteGroup,
				}).pipe(Scope.provide(resources))
				yield* Ref.set(
					diagnostics,
					Fiber.join(transport.exited).pipe(
						Effect.andThen(Ref.get(transport.failures)),
					),
				)
				const aggregate = yield* RpcClient.make(remoteGroup).pipe(
					Effect.provideService(RpcClient.Protocol, transport.protocol),
					Scope.provide(resources),
				)
				// Control is a checked subset of the aggregate group's tags.
				const client = aggregate as object as RpcClient.FromGroup<
					typeof Control,
					RpcClientError.RpcClientError
				>
				const context = yield* Effect.context<never>()
				const bindings = yield* Services.handlers(contract.inject, context)
				yield* RpcServer.make(localGroup, { disableFatalDefects: true }).pipe(
					Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
					Effect.provideContext(
						bindings as Context.Context<Rpc.ToHandler<Rpc.Any>>,
					),
					Effect.tapCause(transport.report),
					Effect.forkIn(resources),
				)
				const race = <A, EX, R>(effect: Effect.Effect<A, EX, R>) =>
					Effect.raceFirst(effect, Deferred.await(transport.failed))
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
										"remote.pid": child.pid,
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
									"remote.pid": child.pid,
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
						const disposed = yield* race(client.Dispose())
						const remoteCause =
							disposed._tag === "Failure"
								? yield* contract.decodeCause(disposed.cause)
								: Cause.empty
						yield* Ref.set(remoteCleanupCause, remoteCause)
						// Control completion never waits behind logs; separately drain the bounded log tail.
						yield* race(Deferred.await(stopped))
						yield* race(Deferred.await(logsEnded))
						yield* Ref.set(transport.stopping, true)
						yield* transport.end
						const status = yield* Fiber.join(transport.exited)
						if (status.exitCode !== 0 || status.statusCause.reasons.length > 0)
							return yield* status
					}).pipe(
						Effect.interruptible,
						Effect.timeout(options.shutdownTimeout ?? "5 seconds"),
						Effect.exit,
					),
				)
				const loaded = yield* race(
					Effect.raceFirst(
						client.Load({
							input: json,
							instance: { id: session, generation: 1 },
						}),
						Deferred.await(remoteFailure),
					),
				)
				if (loaded._tag === "Failure") {
					const cause = yield* contract.decodeCause(loaded.cause)
					return yield* Effect.failCause(cause)
				}
				for (const service of contract.provides)
					yield* service.publish(aggregate)
				yield* Plugin.fork(
					Effect.raceFirst(Fiber.join(events), Deferred.await(remoteFailure)),
				)
				return () => Effect.succeed(false)
			}),
	})
