import { Deferred, Effect, Fiber, Option } from "effect"

import { Plugin } from "@graftland/graft"

import { Authenticator, type AuthenticatorApi } from "../Auth"
import * as Assembly from "../internal/assembly"
import { Peer } from "../internal/Peer"
import {
	closedNormally,
	connectionEnded,
} from "../internal/runner/connectionEnded"
import { RunnerLifecycle } from "../internal/RunnerLifecycle"
import { Supervisor } from "../internal/Supervisor"
import { Listener, type Properties } from "../Transport"

/** Serves the listener, handing each authenticated connection to the supervisor. */
export const consumer = (
	prepare: (
		properties: Properties,
		auth: AuthenticatorApi,
	) => Effect.Effect<void, Assembly.CapabilityCombinationError> = () =>
		Effect.void,
	ready: Effect.Effect<void> = Effect.void,
) =>
	Plugin.make({
		name: "@graftland/plugin-remote/runner/consumer",
		inject: [
			Listener,
			Authenticator,
			Supervisor,
			Plugin.optional(RunnerLifecycle),
		],
		apply: Effect.fnUntraced(function* () {
			const listener = yield* Listener
			const auth = yield* Authenticator
			const supervisor = yield* Supervisor
			const lifecycle = yield* Effect.serviceOption(RunnerLifecycle)
			yield* prepare(listener.properties, auth)
			yield* Assembly.compatible(listener.properties, Assembly.kind(auth)).pipe(
				Effect.mapError((error) =>
					Assembly.ListenerConfigError.make({ detail: error.detail }),
				),
			)
			yield* Assembly.warn(listener.properties, Assembly.kind(auth), "runner")
			const serving = yield* listener.bind(
				auth._tag === "Mtls" ? Option.some(auth.tls) : Option.none(),
			)
			const running = yield* Plugin.fork(
				serving
					.serve(
						Assembly.accept(
							auth,
							listener.properties,
							(identity) => (channel) =>
								supervisor.accept(channel).pipe(
									Effect.catchCause((cause) =>
										listener.properties.protocol === "stdio"
											? closedNormally(cause)
												? Effect.void
												: Effect.failCause(cause)
											: connectionEnded(cause),
									),
									Effect.provideService(Peer, identity),
								),
						),
					)
					.pipe(
						Effect.onExit((exit) =>
							listener.properties.protocol === "stdio" &&
							Option.isSome(lifecycle)
								? Deferred.done(lifecycle.value.ended, exit)
								: Effect.void,
						),
					),
			)
			yield* serving.ready.pipe(Effect.raceFirst(Fiber.join(running)))
			yield* ready
		}),
	})
