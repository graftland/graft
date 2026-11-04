import { children } from "./internal/cleanup"
import { launch } from "./internal/targetAssembly"
import { follow } from "./internal/follow"
import { CapabilityFailed } from "./internal/assembly"
import { executionPlugin, publicError } from "./internal/execution"
import { Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Effect,
	FileSystem,
	Schema,
	References,
	Scope,
} from "effect"
import type { Config, Duration, PlatformError, Schedule } from "effect"
import {
	local,
	worker,
	runner,
	websocket,
	mtls,
	unix,
	command,
	none,
	bearer,
	jwt,
	validate,
	type Target,
	type Runner,
} from "./Targets"
export {
	local,
	worker,
	runner,
	websocket,
	mtls,
	unix,
	command,
	none,
	bearer,
	jwt,
}
import { Instance } from "./Instance"
export { Instance }
import { RemoteWithdrawn, RemoteError, MissingInstance } from "./Errors"
import * as Contract from "./Contract"
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
	return Plugin.make({
		name: contract.name,
		config: Schema.toEncoded(contract.config),
		inject: Effect.isEffect(target) ? [FileSystem.FileSystem] : [],
		retry: options.retry,
		apply: (input) =>
			Effect.gen(function* () {
				yield* Schema.decodeEffect(contract.config)(input).pipe(
					Effect.mapError((error) => publicError(contract.error, error)),
				)
				const configured = yield* Effect.isEffect(target)
					? target.pipe(
							Effect.mapError((error) => publicError(contract.error, error)),
						)
					: Effect.succeed(target)
				yield* validate(configured).pipe(
					Effect.mapError((error) => publicError(contract.error, error)),
				)
				const annotations = yield* References.CurrentLogAnnotations
				const scope = yield* children
				const child = yield* launch(configured, input, (target) =>
					executionPlugin(
						contract,
						{ ...options, retry: undefined },
						target,
						annotations,
					),
				).pipe(Scope.provide(scope))
				const fail = (
					cause: Cause.Cause<unknown>,
				): Cause.Cause<
					| E["Type"]
					| Contract.UndeclaredFailure
					| RemoteWithdrawn
					| RemoteError
					| MissingInstance
				> =>
					Cause.fromReasons(
						Array.flatMap(cause.reasons, (reason) => {
							if (reason._tag !== "Fail") return [reason]
							return Schema.is(CapabilityFailed)(reason.error)
								? Array.map(fail(reason.error.cause).reasons, (inner) =>
										inner.annotate(Cause.reasonAnnotations(reason)),
									)
								: [
										Cause.makeFailReason(
											publicError(contract.error, reason.error),
										).annotate(Cause.reasonAnnotations(reason)),
									]
						}),
					)
				yield* follow(child, (cause) => Effect.failCause(fail(cause)))
				return () => Effect.succeed(false)
			}),
	})
}

export { host as default } from "./internal/entry"
