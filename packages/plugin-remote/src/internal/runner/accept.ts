import { Cause, Effect, Ref, Option, Scope, Semaphore } from "effect"
import { RpcServer } from "effect/rpc"
import { Peer } from "../Peer"
import { TransportError } from "../../Errors"
import type { Channel } from "../../Transport"
import type { Supervisor } from "./Supervisor"
import type { Channels } from "./Execution"
import * as Port from "../port"
import * as Multiplex from "./Multiplex"
import * as Wire from "./Wire"
import { SessionAccessDenied, SessionConflict, type Handle } from "./model"

export const accept = (
	supervisor: typeof Supervisor.Service,
	execution: typeof Channels.Service,
	channel: Channel,
) =>
	Effect.gen(function* () {
		const identity = yield* Peer
		const scope = yield* Effect.scope
		const mux = yield* Multiplex.make(channel)
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
							detail: "The session belongs to another authenticated identity",
						}),
					)
		const handlers = yield* Wire.Session.toHandlers({
			HighWater: ({ instance }) => supervisor.highWater({ identity, instance }),
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
			Load: ({ handle, ...request }) =>
				Effect.gen(function* () {
					yield* authorize(handle)
					const attachment = yield* Ref.get(attached)
					if (Option.isSome(attachment) && attachment.value !== handle.token)
						return yield* SessionConflict.make({
							detail: "A connection can attach only one execution",
						})
					const code = yield* supervisor.load(handle, request)
					if (Option.isNone(attachment)) {
						const child = yield* execution
							.peer(handle.token)
							.pipe(Scope.provide(scope))
						yield* Ref.set(attached, Option.some(handle.token))
						// A child EOF must not destroy the session channel before Dispose can acknowledge exit.
						yield* Effect.all(
							[
								Effect.forever(
									Effect.flatMap(mux.take(1), (bytes) => child.send(1, bytes)),
								),
								Effect.forever(
									Effect.flatMap(child.take(1), (bytes) => mux.send(1, bytes)),
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
				authorize(handle).pipe(Effect.andThen(supervisor.dispose(handle))),
			Status: (handle) =>
				authorize(handle).pipe(Effect.andThen(supervisor.status(handle))),
		})
		return yield* RpcServer.make(Wire.Session, {
			disableFatalDefects: true,
		}).pipe(
			Effect.provideContext(handlers),
			Effect.provideService(RpcServer.Protocol, peer.serverProtocol("session")),
			Effect.raceFirst(mux.await),
		)
	})
