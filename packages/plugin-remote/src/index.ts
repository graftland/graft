import {
	Array,
	Cause,
	Effect,
	Path,
	Schema,
	type Duration,
	type Schedule,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"

import { Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"

import * as Contract from "./Contract"
import { MissingInstance, RemoteError, RemoteWithdrawn } from "./Errors"
import * as Credential from "./host/credentials"
import { launch } from "./host/index"
import { CapabilityFailed } from "./internal/assembly"
import * as Configuration from "./internal/entryConfig"
import { publicError } from "./internal/execution"
import { follow } from "./internal/follow"
import { managedPlugin, type ManagedOptions } from "./internal/transition"

export type { ManagedOptions } from "./internal/transition"
export { candidate, type CandidateOptions } from "./internal/candidate"

export * as Artifact from "./Artifact"

export { Contract }
export { Instance } from "./Instance"
export { RemoteTerminationUnconfirmed } from "./internal/runner/model"
export * from "./Errors"
export { UndeclaredFailure } from "./Contract"
export type {
	Connect,
	Authentication,
	Token as CredentialToken,
	Source as CredentialSource,
} from "./host/credentials"

export interface Options<
	D extends ReadonlyArray<Plugin.Dependency> = readonly [],
> {
	readonly connect: Credential.Connect<D>
	/** Contract module resolved independently in each execution environment. */
	readonly contractModule: string
	/** Implementation module selected by deployment, independently of the contract. */
	readonly implementation: string
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
}
const publicCause = <E extends Schema.Top>(
	declared: E,
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
				? Array.map(
						publicCause(declared, reason.error.cause).reasons,
						(inner) => inner.annotate(Cause.reasonAnnotations(reason)),
					)
				: [
						Cause.makeFailReason(publicError(declared, reason.error)).annotate(
							Cause.reasonAnnotations(reason),
						),
					]
		}),
	)

/** Fixes deployment options; business config is plugin input, and updates restart the execution unit. */
const unmanagedPlugin = <
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
> =>
	Plugin.make({
		name: contract.name,
		inject: [
			Plugin.optional(ModuleResolver.ModuleResolver),
			Path.Path,
			SecureRandom.SecureRandom,
			ChildProcessSpawner.ChildProcessSpawner,
		],
		retry: options.retry,
		config: Schema.toEncoded(contract.config),
		apply: (config) =>
			Effect.gen(function* () {
				const auth = Credential.invocation(options.connect)
				const input = yield* Schema.decodeUnknownEffect(Configuration.Host)({
					contract: options.contractModule,
					implementation: options.implementation,
					connect:
						auth === undefined
							? options.connect
							: {
									...options.connect,
									auth: { name: "effect-credentials" },
								},
					config,
				})
				yield* Schema.decodeEffect(contract.config)(input.config)
				const child = yield* launch(
					contract,
					input,
					{
						contractModule: options.contractModule,
						implementation: options.implementation,
						shutdownTimeout: options.shutdownTimeout,
					},
					auth,
				)
				yield* follow(child, (cause) =>
					Effect.failCause(publicCause(contract.error, cause)),
				)
			}).pipe(Effect.mapError((error) => publicError(contract.error, error))),
	})
export { default } from "./host/index"

/** Selects an ordinary module deployment or an artifact-backed managed direct deployment. */
export function plugin<
	S extends Contract.ConfigSchema,
	E extends Contract.ErrorSchema,
>(
	contract: Contract.Contract<S, E>,
	options: ManagedOptions,
): ReturnType<typeof managedPlugin<S, E>>
export function plugin<
	S extends Contract.ConfigSchema,
	E extends Contract.ErrorSchema,
	const D extends ReadonlyArray<Plugin.Dependency> = readonly [],
>(
	contract: Contract.Contract<S, E>,
	options: Options<D>,
): ReturnType<typeof unmanagedPlugin<S, E, D>>
export function plugin<
	S extends Contract.ConfigSchema,
	E extends Contract.ErrorSchema,
	const D extends ReadonlyArray<Plugin.Dependency> = readonly [],
>(contract: Contract.Contract<S, E>, options: Options<D> | ManagedOptions) {
	return "artifact" in options
		? managedPlugin(contract, options)
		: unmanagedPlugin(contract, options)
}
