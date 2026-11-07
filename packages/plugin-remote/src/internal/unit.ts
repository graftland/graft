import { Array, Cause, Effect, Option, Ref, Scope, type Schema } from "effect"
import { SecureRandom } from "effect/crypto"

import * as Artifact from "../Artifact"
import type * as Contract from "../Contract"
import { RemoteError, type ProcessExited, type TransportError } from "../Errors"
import { cleanupCause } from "./cleanup"
import { prepare } from "./contract"
import * as Control from "./control"
import {
	LocalTransport,
	WorkerTransport,
	type Execution,
} from "./directTransport"
import * as Host from "./host"
import {
	Connection,
	type LocalTarget,
	type WorkerTarget,
} from "./runner/Connection"
import * as Local from "./runner/Local"
import * as Services from "./services"

export interface Options {
	readonly clearEnvironment?: boolean
	readonly sandbox?: import("../Sandbox").Launch
	readonly contractModule: string
	readonly artifact: Artifact.Artifact
	readonly target: LocalTarget | WorkerTarget
	readonly onSpawn?: Effect.Effect<void>
	readonly onExecution?: (execution: Execution) => Effect.Effect<void>
}

/** An independently owned direct unit. Nothing publishes its clients into the host graph. */
export const open = Effect.fnUntraced(function* <
	S extends Contract.ConfigSchema,
	E extends Contract.ErrorSchema,
>(descriptor: Contract.Contract<S, E>, options: Options) {
	const implementation = yield* Artifact.implementation(options.artifact)
	const owner = yield* Effect.scope
	// Explicit termination confirms exit before either scope closes.
	const process = yield* Scope.fork(owner)
	const resources = yield* Scope.fork(owner)
	const transport = yield* options.target._tag === "Local"
		? LocalTransport
		: WorkerTransport
	const random = yield* SecureRandom.SecureRandom
	const session = yield* random.uuidV4()
	const started: Effect.Effect<
		Execution,
		import("effect").PlatformError.PlatformError | TransportError,
		Scope.Scope
	> = transport.start(
		{
			...options.target,
			...(options.clearEnvironment === undefined
				? {}
				: { clearEnvironment: options.clearEnvironment }),
			...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
			contractModule: options.contractModule,
			implementation,
			session,
		},
		options.onSpawn,
	)
	const execution = yield* Effect.uninterruptible(
		started.pipe(
			Scope.provide(process),
			Effect.tap(
				(execution) => options.onExecution?.(execution) ?? Effect.void,
			),
		),
	)
	const evidence = yield* Ref.make<Option.Option<ProcessExited>>(Option.none())
	yield* Effect.addFinalizer(() =>
		execution.terminate.pipe(
			// Forced exit diagnostics belong to the exit evidence, including the platform's SIGKILL cause.
			Effect.tap((status) => Ref.set(evidence, Option.some(status))),
			Effect.asVoid,
			Effect.catchCause((cause) => Effect.failCause(cleanupCause(cause))),
		),
	)
	const exited = execution.exited.pipe(
		Effect.tap((status) => Ref.set(evidence, Option.some(status))),
	)
	yield* exited.pipe(Effect.forkIn(resources))
	const contract = prepare(descriptor)
	const connection = yield* Local.connect(execution, {
		session,
		serve: Services.endpoints(descriptor.inject),
		call: {
			...Services.endpoints(descriptor.provides),
			[Control.endpoint]: contract.control,
		},
	}).pipe(Scope.provide(resources))
	const active = yield* Host.initialize(contract).pipe(
		Effect.provideService(Connection, connection),
	)
	const request = <A, Error, R>(effect: Effect.Effect<A, Error, R>) =>
		Effect.raceFirst(effect, connection.transport.failure).pipe(
			Effect.catchCause((cause) =>
				RemoteError.make({
					cause: Cause.fromReasons(
						Array.flatMap(
							cause.reasons,
							(reason): ReadonlyArray<Cause.Reason<unknown>> =>
								reason._tag === "Fail" && Cause.isCause(reason.error)
									? Array.map(reason.error.reasons, (inner) =>
											inner.annotate(Cause.reasonAnnotations(reason)),
										)
									: [reason],
						),
					),
				}),
			),
		)
	const terminate = Effect.fnUntraced(function* (mode: "graceful" | "forced") {
		if (mode === "graceful") yield* connection.terminate(true)
		const status = yield* mode === "forced" ? execution.terminate : exited
		yield* Ref.set(evidence, Option.some(status))
		return status
	})
	return {
		artifact: options.artifact.identity,
		describe: request(active.client.Describe()),
		serve: (input: Schema.Json) => request(active.client.Serve({ input })),
		ready: request(
			Effect.raceFirst(active.client.Ready(), active.remoteFailure.await),
		),
		probe: (name: string) =>
			request(
				Effect.raceFirst(
					active.client.Probe({ name }),
					active.remoteFailure.await,
				),
			),
		stop: request(Host.dispose(active)),
		terminate,
		exited,
		exit: Ref.get(evidence),
		failure: request(active.remoteFailure.await),
		failures: active.remoteFailure.cause,
		// Clients are created privately; publication belongs to the later facade driver.
		clientProtocol: connection.transport.clientProtocol,
	}
})
