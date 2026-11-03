import { TransportError } from "../../Errors"
import {
	Context,
	Cause,
	Effect,
	Ref,
	Option,
	Scope,
	Semaphore,
	Layer,
} from "effect"
import { RpcServer } from "effect/rpc"
import * as Port from "../port"
import * as ExecutionAdapter from "./Execution"
import * as Lock from "./Lock"
import * as Multiplex from "./Multiplex"
import * as Stores from "./Store"
import * as Supervisor from "./Supervisor"
import * as Tls from "./Tls"
import * as Wire from "./Wire"
import { SessionAccessDenied, SessionConflict, type Handle } from "./model"

export interface Options extends Tls.ListenOptions {
	readonly root: string
	readonly state: string
	readonly lease?: Supervisor.Options["lease"]
	readonly grace?: Supervisor.Options["grace"]
}
export const serve = (options: Options) =>
	Effect.gen(function* () {
		yield* Lock.acquire(options.state)
		const dependencies = Layer.merge(
			Stores.layerDirectory(options.state),
			ExecutionAdapter.layer(options.root),
		)
		const services = yield* Layer.build(
			Supervisor.layer({
				...(options.lease === undefined ? {} : { lease: options.lease }),
				...(options.grace === undefined ? {} : { grace: options.grace }),
			}).pipe(Layer.provideMerge(dependencies)),
		)
		const supervisor = services.pipe(Context.get(Supervisor.Supervisor))
		const execution = services.pipe(Context.get(ExecutionAdapter.Channels))
		const listener = yield* Tls.listen(options)
		const server = yield* listener
			.run((socket) =>
				Effect.gen(function* () {
					const identity = yield* Tls.Peer
					const scope = yield* Effect.scope
					const mux = yield* Multiplex.fromSocket(socket)
					const peer = yield* Port.make(Wire.channel(mux, 0), {
						session: "session-v1",
						serve: { session: Wire.Session },
						call: {},
					})
					const attached = yield* Ref.make(Option.none<string>())
					const loading = yield* Semaphore.make(1)
					const authorize = (handle: Handle) =>
						handle.key.identity === identity
							? Effect.void
							: Effect.fail(
									SessionAccessDenied.make({
										detail:
											"The session belongs to another authenticated identity",
									}),
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
									return yield* SessionConflict.make({
										detail: "A connection can attach only one execution",
									})
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
												Effect.flatMap(mux.take(1), (bytes) =>
													child.send(1, bytes),
												),
											),
											Effect.forever(
												Effect.flatMap(child.take(1), (bytes) =>
													mux.send(1, bytes),
												),
											),
										],
										{ concurrency: "unbounded" },
									).pipe(
										Effect.catchCause((cause) =>
											Cause.hasInterruptsOnly(cause)
												? Effect.void
												: child.fail(TransportError.make({ cause })),
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
					return yield* RpcServer.make(Wire.Session, {
						disableFatalDefects: true,
					}).pipe(
						Effect.provideContext(handlers),
						Effect.provideService(
							RpcServer.Protocol,
							peer.serverProtocol("session"),
						),
						Effect.raceFirst(mux.await),
					)
				}),
			)
			.pipe(Effect.raceFirst(supervisor.await), Effect.forkScoped)
		return { address: listener.address, supervisor, server }
	})
