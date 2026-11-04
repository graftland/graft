import { Entry } from "@graftland/loader"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Effect,
	Fiber,
	FileSystem,
	Option,
	Schema,
	Scope,
	Stream,
} from "effect"
import type { Config, Duration, PlatformError, Schedule } from "effect"
import { SecureRandom } from "effect/crypto"
import {
	local,
	runner,
	websocket,
	mtls,
	dependencies,
	type Target,
	type Runner,
} from "./Targets"
export { local, runner, websocket, mtls }
import * as Connection from "./internal/runner/Connection"
import * as Services from "./internal/services"
import { Instance } from "./Instance"
export { Instance }
import * as Host from "./internal/host"
import { RemoteWithdrawn, RemoteError, MissingInstance } from "./Errors"
import * as Contract from "./Contract"
import * as Control from "./internal/control"
export { Contract }
export { RemoteTerminationUnconfirmed } from "./internal/runner/model"
export { RemoteError, RemoteWithdrawn, MissingInstance } from "./Errors"

export interface Options<
	D extends ReadonlyArray<Plugin.Dependency> = readonly [],
> {
	/** A configured runner is evaluated on activation, with access to certificate files. */
	readonly target?:
		| Target<D>
		| Effect.Effect<
				Runner<D>,
				Config.ConfigError | PlatformError.PlatformError,
				FileSystem.FileSystem
		  >
	/** Contract module exported as default or named `contract`, resolved in the runner installation. */
	readonly contractModule: string
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
}

/** One owned execution per activation, with explicitly mapped services. */
const executionPlugin = <
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	D extends ReadonlyArray<Plugin.Dependency>,
>(
	contract: Contract.Contract<S, E>,
	options: Options<D>,
	configured: Target<D>,
): Plugin.Plugin<
	S["Encoded"],
	S["Encoded"],
	| E["Type"]
	| Contract.UndeclaredFailure
	| RemoteError
	| RemoteWithdrawn
	| MissingInstance
> =>
	Plugin.make({
		name: contract.name,
		inject: [
			SecureRandom.SecureRandom,
			...dependencies(configured),
			...Array.map(contract.inject, (service) => service.key),
		],
		config: Schema.toEncoded(contract.config),
		retry: options.retry,
		apply: (input) =>
			Effect.gen(function* () {
				const random = yield* SecureRandom.SecureRandom
				const session = yield* random.uuidV4()
				yield* Schema.decodeEffect(contract.config)(input)
				const target = yield* resolveTarget(configured)
				const active = yield* Connection.acquire(
					target,
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
):
	| E["Type"]
	| Contract.UndeclaredFailure
	| RemoteWithdrawn
	| RemoteError
	| MissingInstance =>
	Schema.is(declared)(error)
		? error
		: Schema.is(Contract.UndeclaredFailure)(error) ||
			  Schema.is(RemoteWithdrawn)(error) ||
			  Schema.is(MissingInstance)(error)
			? error
			: RemoteError.make({ cause: Cause.fail(error) })

const resolveTarget = <D extends ReadonlyArray<Plugin.Dependency>>(
	target: Target<D>,
): Effect.Effect<Connection.Target<D>, MissingInstance> =>
	Effect.gen(function* () {
		if (target._tag === "Local") return target
		const instance =
			target.instance === undefined
				? yield* Entry.CurrentId
				: Option.some(target.instance)
		if (Option.isNone(instance)) return yield* MissingInstance.make({})
		return { ...target, instance: instance.value }
	})

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
	const D extends ReadonlyArray<Plugin.Dependency> = readonly [],
>(
	contract: Contract.Contract<S, E>,
	options: Options<D>,
): Plugin.Plugin<
	S["Encoded"],
	S["Encoded"],
	| E["Type"]
	| Contract.UndeclaredFailure
	| RemoteError
	| RemoteWithdrawn
	| MissingInstance
> => {
	const target = options.target ?? local()
	if (!Effect.isEffect(target))
		return executionPlugin(contract, options, target)
	return Plugin.make({
		name: contract.name,
		config: Schema.toEncoded(contract.config),
		inject: [FileSystem.FileSystem],
		retry: options.retry,
		apply: (input) =>
			Effect.gen(function* () {
				const configured = yield* target.pipe(
					Effect.mapError((error) => publicError(contract.error, error)),
				)
				const child = yield* Graft.plugin(
					executionPlugin(
						contract,
						{ ...options, retry: undefined },
						configured,
					),
					input,
				)
				yield* child.await
				// The child owns the resolved dependencies; failures still belong to this proxy.
				yield* Plugin.fork(
					child.state.pipe(
						Stream.runForEach((state) =>
							state._tag === "Failed"
								? Effect.failCause(state.cause)
								: Effect.void,
						),
					),
				)
				return () => Effect.succeed(false)
			}),
	})
}
