import { Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import { Array, Cause, Effect, Path, Schema } from "effect"
import type { Duration, Schedule } from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"
import { launch } from "./internal/entry"
import { follow } from "./internal/follow"
import { CapabilityFailed } from "./internal/assembly"
import { publicError } from "./internal/execution"
import * as Configuration from "./internal/entryConfig"
import * as Credential from "./internal/credentials"
import { RemoteWithdrawn, RemoteError, MissingInstance } from "./Errors"
import * as Contract from "./Contract"
export { Contract }
export { Instance } from "./Instance"
export { RemoteTerminationUnconfirmed } from "./internal/runner/model"
export { RemoteError, RemoteWithdrawn, MissingInstance } from "./Errors"
export { UndeclaredFailure, ChildFailure } from "./Contract"
export type {
	Connect,
	Source as CredentialSource,
} from "./internal/credentials"

export interface Options<
	D extends ReadonlyArray<Plugin.Dependency> = readonly [],
> {
	readonly connect: Credential.Connect<D>
	/** Contract module resolved independently in each execution environment. */
	readonly contractModule: string
	readonly config?: Schema.Json
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
	options: Options<D> & { readonly config?: S["Encoded"] },
): Plugin.Plugin<
	void,
	void,
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
		apply: () =>
			Effect.gen(function* () {
				const input = yield* Schema.decodeUnknownEffect(Configuration.Host)({
					contract: options.contractModule,
					connect: options.connect,
					config: options.config === undefined ? {} : options.config,
				})
				yield* Schema.decodeEffect(contract.config)(input.config)
				const child = yield* launch(
					contract,
					input,
					{
						contractModule: options.contractModule,
						shutdownTimeout: options.shutdownTimeout,
					},
					Credential.invocation(options.connect),
				)
				yield* follow(child, (cause) =>
					Effect.failCause(publicCause(contract.error, cause)),
				)
			}).pipe(Effect.mapError((error) => publicError(contract.error, error))),
	})
export { host as default } from "./internal/entry"
