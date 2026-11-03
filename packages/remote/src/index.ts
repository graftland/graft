import { SessionError } from "./internal/runner/Wire"
import { Graft, Plugin } from "@graftland/graft"
import { Array, Deferred, Effect, Fiber, Schema, Scope } from "effect"
import type { Duration, Schedule, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { type RpcClientError } from "effect/rpc"
import { SecureRandom } from "effect/crypto"
import { local, runner, type Target } from "./Targets"
export { local, runner }
import * as Connection from "./internal/runner/Connection"
import { RemoteTerminationUnconfirmed } from "./internal/runner/model"
export { SessionError, RemoteTerminationUnconfirmed }
import * as Services from "./internal/services"
import { Instance } from "./Instance"
export { Instance }
import * as Host from "./internal/host"
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
				const active = yield* Connection.acquire(
					options.target ?? local(),
					options.contractModule,
					{
						session,
						serve: Services.endpoints(contract.inject),
						call: {
							...Services.endpoints(contract.provides),
							[Control.endpoint]: contract.control,
						},
					},
					Host.initialize(contract),
					Host.dispose,
					options.shutdownTimeout ?? "5 seconds",
				)
				yield* Host.load(active, json)
				for (const service of contract.provides)
					yield* service
						.publish(active.connection.transport)
						.pipe(Scope.provide(active.connection.resources))
				yield* Plugin.fork(
					Effect.raceFirst(
						Fiber.join(active.events),
						Deferred.await(active.remoteFailure),
					),
				)
				return () => Effect.succeed(false)
			}),
	})
