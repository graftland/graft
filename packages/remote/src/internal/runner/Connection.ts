import {
	LocalTransport,
	WorkerTransport,
	type Execution,
} from "../../Transport"
import * as RunnerConnection from "../host/runner"
import {
	Array,
	Cause,
	Context,
	Effect,
	Duration,
	Exit,
	Option,
	Scope,
} from "effect"
import type { RpcClientError } from "effect/rpc"
import type { Schema, PlatformError } from "effect"
import type { RemoteTerminationUnconfirmed } from "./model"
import type {
	Local as LocalTarget,
	Worker as WorkerTarget,
	RunnerCommon,
} from "../../Targets"
import {
	LocalTerminationTimeout,
	ProcessExited,
	TransportError,
} from "../../Errors"
import { cleanupCause } from "../cleanup"
import * as Port from "../port"
import * as LocalProcess from "./Local"
import * as Wire from "./Wire"

export interface ConfiguredRunner extends Omit<RunnerCommon, "_tag"> {
	readonly _tag: "Connector"
	readonly explicitAuth?: boolean
}
export type Target =
	| LocalTarget
	| WorkerTarget
	| (ConfiguredRunner & { readonly instance: string })

type Peer = Port.Port
export interface Connected {
	readonly resources: Scope.Scope
	readonly pid: Option.Option<number>
	readonly threadId?: number
	readonly diagnostics: Effect.Effect<Cause.Cause<unknown>>
	readonly terminate: (
		graceful: boolean,
	) => Effect.Effect<
		void,
		| ProcessExited
		| LocalTerminationTimeout
		| TransportError
		| Schema.SchemaError
		| Wire.SessionError
		| RemoteTerminationUnconfirmed
		| RpcClientError.RpcClientError
	>
	readonly transport: {
		readonly clientProtocol: Peer["clientProtocol"]
		readonly serverProtocol: Peer["serverProtocol"]
		readonly failure: Effect.Effect<never, ProcessExited | TransportError>
		readonly report: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
	}
}
export class Connection extends Context.Service<Connection, Connected>()(
	"@graftland/plugin-remote/internal/runner/Connection",
) {}
const connected = Connection.of

const Local = Effect.fnUntraced(function* (
	target: LocalTarget | WorkerTarget,
	contractModule: string,
	options: Port.Options,
	resources: Scope.Scope,
	processScope: Scope.Scope,
) {
	const transport = yield* target._tag === "Local"
		? LocalTransport
		: WorkerTransport
	const started: Effect.Effect<
		Execution,
		PlatformError.PlatformError | TransportError,
		Scope.Scope
	> = transport.start({ ...target, contractModule, session: options.session })
	const execution = yield* started.pipe(Scope.provide(processScope))
	return yield* LocalProcess.connect(execution, options).pipe(
		Scope.provide(resources),
	)
})

const reason = <A, E>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit) ? exit.cause : Cause.empty
const finish = (causes: ReadonlyArray<Cause.Cause<unknown>>) => {
	const cause = Array.reduce(causes, Cause.empty, Cause.combine)
	return cause.reasons.length === 0
		? Effect.void
		: Effect.failCause(cleanupCause(cause))
}

/** Close partially acquired resources too; the normal release observes exit before stopping readers. */
const scopes = Effect.acquireRelease(
	Effect.all({ resources: Scope.make(), process: Scope.make() }),
	(scopes, exit) =>
		Effect.gen(function* () {
			const process = yield* Effect.exit(Scope.close(scopes.process, exit))
			const resources = yield* Effect.exit(Scope.close(scopes.resources, exit))
			yield* finish([reason(process), reason(resources)])
		}),
)

/** Setup supplies a concrete control lifecycle; release never reads a later-installed effect. */
export const acquire = <A, E, R, D, DR>(
	target: Target,
	contractModule: string,
	options: Port.Options,
	setup: Effect.Effect<A, E, R | Connection>,
	dispose: (value: A) => Effect.Effect<Cause.Cause<unknown>, D, DR>,
	timeout: Duration.Input,
) =>
	Effect.gen(function* () {
		const owned = yield* scopes
		const connection = yield* Effect.acquireRelease(
			Effect.gen(function* () {
				return target._tag === "Local" || target._tag === "Worker"
					? yield* Local(
							target,
							contractModule,
							options,
							owned.resources,
							owned.process,
						).pipe(Effect.map(connected))
					: yield* RunnerConnection.connect(
							target,
							contractModule,
							options,
							owned.resources,
							owned.process,
						)
			}).pipe(Effect.interruptible),
			(connection, exit) =>
				Effect.gen(function* () {
					const process = yield* Effect.exit(Scope.close(owned.process, exit))
					// Wait for exit while readers are alive; collect their final cause after resources close.
					yield* connection.diagnostics
					const resources = yield* Effect.exit(
						Scope.close(owned.resources, exit),
					)
					const diagnostics = yield* connection.diagnostics
					yield* finish([reason(process), reason(resources), diagnostics])
				}),
		)
		return yield* Effect.acquireRelease(
			setup.pipe(Effect.provideService(Connection, connection)),
			(value) =>
				Effect.gen(function* () {
					const graceful = yield* dispose(value).pipe(
						Effect.interruptible,
						Effect.timeout(timeout),
						Effect.exit,
					)
					const terminated = yield* Effect.exit(
						connection.terminate(Exit.isSuccess(graceful)),
					)
					yield* finish([
						Exit.isSuccess(graceful) ? graceful.value : graceful.cause,
						reason(terminated),
					])
				}),
		)
	})
