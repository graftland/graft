import { Cause, Deferred, Effect, Ref, Option, Scope, Semaphore } from "effect"
import { RpcGroup, RpcServer } from "effect/rpc"
import * as Services from "../services"
import * as Duplex from "../duplex"
import * as ExecutionAdapter from "./Execution"
import * as Lock from "./Lock"
import * as Multiplex from "./Multiplex"
import * as Stores from "./Store"
import * as Supervisor from "./Supervisor"
import * as Tls from "./Tls"
import * as Wire from "./Wire"
import { Execution, Store, failure, type Handle } from "./model"

export interface Options extends Tls.ListenOptions {
	readonly root: string
	readonly state: string
	readonly lease?: Supervisor.Options["lease"]
	readonly grace?: Supervisor.Options["grace"]
}
export const serve = (options: Options) =>
	Effect.gen(function* () {
		yield* Lock.acquire(options.state)
		const store = yield* Stores.directory(options.state)
		const ready =
			yield* Deferred.make<Effect.Success<ReturnType<typeof Supervisor.make>>>()
		const execution = yield* ExecutionAdapter.make(options.root, (handle) =>
			Deferred.await(ready).pipe(
				Effect.flatMap((supervisor) => supervisor.status(handle)),
				Effect.map((record) => record.limits),
			),
		)
		const supervisor = yield* Supervisor.make({
			...(options.lease === undefined ? {} : { lease: options.lease }),
			...(options.grace === undefined ? {} : { grace: options.grace }),
		}).pipe(
			Effect.provideService(Store, store),
			Effect.provideService(Execution, execution.driver),
		)
		yield* Deferred.succeed(ready, supervisor)
		const listener = yield* Tls.listen(options)
		const server = yield* listener
			.run((socket) =>
				Effect.gen(function* () {
					const identity = yield* Tls.Peer
					const scope = yield* Effect.scope
					const mux = yield* Multiplex.fromSocket(socket)
					const peer = yield* Duplex.make(Wire.channel(mux, 0), {
						session: "session-v1",
						local: Services.combine(Wire.Session, []),
						remote: Services.combine(RpcGroup.make(), []),
					})
					const attached = yield* Ref.make(Option.none<string>())
					const loading = yield* Semaphore.make(1)
					const authorize = (handle: Handle) =>
						handle.key.identity === identity
							? Effect.void
							: Effect.fail(
									failure(
										"InvalidRequest",
										"The session belongs to another authenticated identity",
									),
								)
					const handlers = yield* Wire.Session.toHandlers({
						HighWater: ({ instance }) =>
							supervisor.highWater({ identity, instance }),
						Open: ({
							instance,
							requestId,
							expectedGeneration,
							leaseMillis,
							limits,
						}) =>
							supervisor.open({
								key: { identity, instance },
								requestId,
								expectedGeneration,
								...(leaseMillis === undefined ? {} : { lease: leaseMillis }),
								limits,
							}),
						Load: ({ handle, specifier }) =>
							Effect.gen(function* () {
								yield* authorize(handle)
								const attachment = yield* Ref.get(attached)
								if (
									Option.isSome(attachment) &&
									attachment.value !== handle.token
								)
									return yield* failure(
										"Conflict",
										"A connection can attach only one execution",
									)
								const code = yield* supervisor.load(handle, { specifier })
								if (Option.isNone(attachment)) {
									const child = yield* execution
										.peer(handle.token)
										.pipe(Scope.provide(scope))
									yield* Ref.set(attached, Option.some(handle.token))
									// A child EOF must not destroy the session channel before Dispose can acknowledge exit.
									yield* Effect.all(
										[
											Effect.forever(
												Effect.flatMap(mux.take(1, 1), (bytes) =>
													child.send(1, 1, bytes),
												),
											),
											Effect.forever(
												Effect.flatMap(child.take(1, 1), (bytes) =>
													mux.send(1, 1, bytes),
												),
											),
										],
										{ concurrency: "unbounded" },
									).pipe(
										Effect.catchCause((cause) =>
											Cause.hasInterruptsOnly(cause)
												? Effect.void
												: Effect.logDebug("Instance relay ended", cause),
										),
										Effect.forkIn(scope),
									)
								}
								return code
							}).pipe(loading.withPermit),
						Renew: (handle) =>
							authorize(handle).pipe(Effect.andThen(supervisor.renew(handle))),
						Dispose: (handle) =>
							authorize(handle).pipe(
								Effect.andThen(supervisor.dispose(handle)),
							),
						Status: (handle) =>
							authorize(handle).pipe(Effect.andThen(supervisor.status(handle))),
					})
					yield* RpcServer.make(Wire.Session, {
						disableFatalDefects: true,
					}).pipe(
						Effect.provideContext(handlers),
						Effect.provideService(RpcServer.Protocol, peer.serverProtocol),
						Effect.forkIn(scope),
					)
					return yield* Deferred.await(mux.failed)
				}),
			)
			.pipe(Effect.forkScoped)
		return { address: listener.address, supervisor, server }
	})
