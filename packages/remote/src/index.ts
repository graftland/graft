import { Plugin } from "@graftland/graft"
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
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, type RpcClientError } from "effect/rpc"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { cleanupCause } from "./internal/cleanup"
import type { ProcessExited, TransportError } from "./Errors"
import * as Contract from "./Contract"
import { Control } from "./internal/control"
import * as Transport from "./internal/transport"
export { Contract }
export { ProcessExited, TransportError } from "./Errors"

export interface Options {
	/** Contract module exported as default or named `contract`, resolved in the runner installation. */
	readonly contractModule: string
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
}

/** Prototype: one fresh local process for every activation, with no service bridge. */
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
> =>
	Plugin.make({
		name: contract.name,
		inject: [ChildProcessSpawner.ChildProcessSpawner],
		config: Schema.toEncoded(contract.config),
		retry: options.retry,
		apply: (input) =>
			Effect.gen(function* () {
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
				const transport = yield* Transport.make(child).pipe(
					Scope.provide(resources),
				)
				yield* Ref.set(
					diagnostics,
					Fiber.join(transport.exited).pipe(
						Effect.andThen(Ref.get(transport.failures)),
					),
				)
				const client = yield* RpcClient.make(Control).pipe(
					Effect.provideService(RpcClient.Protocol, transport.protocol),
					Scope.provide(resources),
				)
				const race = <A, EX, R>(effect: Effect.Effect<A, EX, R>) =>
					Effect.raceFirst(effect, Deferred.await(transport.failed))
				const stopped = yield* Deferred.make<void>()
				const remoteFailure = yield* Deferred.make<
					never,
					E["Type"] | Contract.UndeclaredFailure
				>()
				const events = yield* client.Events().pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							if (event._tag === "Stopped") {
								yield* Deferred.succeed(stopped, undefined)
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
				const loaded = yield* race(client.Load({ input: json }))
				if (loaded._tag === "Failure") {
					const cause = yield* contract.decodeCause(loaded.cause)
					return yield* Effect.failCause(cause)
				}
				yield* Plugin.fork(
					Effect.raceFirst(Fiber.join(events), Deferred.await(remoteFailure)),
				)
				return () => Effect.succeed(false)
			}),
	})
