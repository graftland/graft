import { Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Effect,
	Fiber,
	PlatformError,
	Schema,
	Scope,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { RpcClientError } from "effect/rpc"
import type {
	LocalTarget as Local,
	WorkerTarget as Worker,
} from "./runner/Connection"
import { Connector } from "../Transport"
import { LocalTransport, WorkerTransport } from "./directTransport"
import { Credentials } from "../Auth"
import type { Duration } from "effect"
import * as Connection from "./runner/Connection"
import * as Services from "./services"
import * as Host from "./host"
import * as Errors from "../Errors"
import { RemoteWithdrawn, RemoteError, MissingInstance } from "../Errors"
import * as ChildErrors from "./childErrors"
import * as Assembly from "./assembly"
import * as Model from "./runner/model"
import { ReleaseInterrupted } from "./release"
import * as Contract from "../Contract"
import * as Control from "./control"
import { prepare } from "./contract"

export interface ExecutionOptions {
	readonly contractModule: string
	readonly shutdownTimeout?: Duration.Input | undefined
}

const dependencies = (
	target: Local | Worker | Connection.ConfiguredRunner,
): ReadonlyArray<Plugin.Dependency> =>
	target._tag === "Connector"
		? [Connector, Credentials]
		: target._tag === "Local"
			? [LocalTransport]
			: [WorkerTransport]

/** One owned execution per activation, with explicitly mapped services. */
export const executionPlugin = <
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
	contract: Contract.Contract<S, E>,
	options: ExecutionOptions,
	configured: Local | Worker | Connection.ConfiguredRunner,
	annotations: Readonly<Record<string, unknown>> = {},
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
		apply: Effect.fnUntraced(
			function* (input: Schema.Json) {
				const prepared = prepare(contract)
				const random = yield* SecureRandom.SecureRandom
				const session = yield* random.uuidV4()
				const active = yield* Connection.acquire(
					configured,
					options.contractModule,
					{
						session,
						serve: Services.endpoints(contract.inject),
						call: {
							...Services.endpoints(contract.provides),
							[Control.endpoint]: prepared.control,
						},
					},
					Host.initialize(prepared),
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
			},
			Effect.annotateLogs(annotations),
			Effect.mapError((error) => publicError(contract.error, error)),
		),
	})

/** Failures raised by the host machinery; a permissive declared schema must not claim them. */
const internalErrors: ReadonlyArray<abstract new (...args: never) => unknown> =
	[
		Errors.ProcessExited,
		Errors.TransportError,
		Errors.LocalTerminationTimeout,
		Errors.CredentialsError,
		Errors.AuthenticationFailed,
		Errors.RemoteEntryError,
		ChildErrors.AlreadyLoaded,
		ChildErrors.ContractNotFound,
		ChildErrors.ModuleImportFailed,
		ChildErrors.ActivationFailed,
		Model.PackageError,
		Model.SessionAccessDenied,
		Model.StaleSession,
		Model.LeaseExpired,
		Model.SessionStopped,
		Model.SessionConflict,
		Model.StateStorageError,
		Model.ExecutionError,
		Model.TerminationUnconfirmed,
		Model.RunnerClosing,
		Model.StateDirectoryLocked,
		Model.RemoteTerminationUnconfirmed,
		ReleaseInterrupted,
		RpcClientError.RpcClientError,
		...Assembly.errors,
	]
const isInternal = (error: unknown) =>
	Schema.isSchemaError(error) ||
	PlatformError.isPlatformError(error) ||
	Array.some(internalErrors, (Class) => error instanceof Class)
const isPublic = (
	error: unknown,
): error is
	| Contract.UndeclaredFailure
	| RemoteWithdrawn
	| RemoteError
	| MissingInstance =>
	Schema.is(Contract.UndeclaredFailure)(error) ||
	Schema.is(RemoteWithdrawn)(error) ||
	Schema.is(RemoteError)(error) ||
	Schema.is(MissingInstance)(error)

export const publicError = <E extends Schema.Top>(
	declared: E,
	error: unknown,
):
	| E["Type"]
	| Contract.UndeclaredFailure
	| RemoteWithdrawn
	| RemoteError
	| MissingInstance =>
	isPublic(error)
		? error
		: // Classify host failures before the declared schema, which may be structural.
			!isInternal(error) && Schema.is(declared)(error)
			? error
			: RemoteError.make({ cause: Cause.fail(error) })
