import { Plugin } from "@graftland/graft"
import { Array, Cause, Effect, Fiber, Schema, Scope } from "effect"
import type { Duration, Schedule } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SecureRandom } from "effect/crypto"
import { local, runner, type Target } from "./Targets"
export { local, runner }
import * as Connection from "./internal/runner/Connection"
import * as Services from "./internal/services"
import { Instance } from "./Instance"
export { Instance }
import * as Host from "./internal/host"
import { RemoteWithdrawn, RemoteError } from "./Errors"
import * as Contract from "./Contract"
import * as Control from "./internal/control"
export { Contract }
export { RemoteError, RemoteWithdrawn } from "./Errors"

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
	E["Type"] | Contract.UndeclaredFailure | RemoteError | RemoteWithdrawn
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
				const session = yield* SecureRandom.make((size) =>
					globalThis.crypto.getRandomValues(new Uint8Array(size)),
				).uuidV4()
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
				yield* Host.load(active, input)
				for (const service of contract.provides)
					yield* service
						.publish(active.connection.transport)
						.pipe(Scope.provide(active.connection.resources))
				yield* Plugin.fork(
					Effect.raceFirst(
						Fiber.join(active.events),
						active.remoteFailure.await,
					).pipe(
						Effect.mapError((error) => publicError(contract.error, error)),
					),
				)
				return () => Effect.succeed(false)
			}).pipe(Effect.mapError((error) => publicError(contract.error, error))),
	})

const publicError = <E extends Schema.Top>(
	declared: E,
	error: unknown,
): E["Type"] | Contract.UndeclaredFailure | RemoteWithdrawn | RemoteError =>
	Schema.is(declared)(error)
		? error
		: Schema.is(Contract.UndeclaredFailure)(error) ||
			  Schema.is(RemoteWithdrawn)(error)
			? error
			: RemoteError.make({ cause: Cause.fail(error) })
