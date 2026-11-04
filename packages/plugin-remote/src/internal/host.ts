import * as FailureGroup from "./FailureGroup"
import * as ContractModule from "../Contract"
import {
	Cause,
	Array,
	Deferred,
	Effect,
	Ref,
	Option,
	Schema,
	Scope,
	Stream,
} from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { RemoteWithdrawn } from "../Errors"
import * as Control from "./control"
import { cleanupCause } from "./cleanup"
import { Connection } from "./runner/Connection"
import type { Service } from "../Contract"
import type { ChildFailure } from "./childErrors"
import type { prepare } from "./contract"

type ErrorSchema = Schema.Top & {
	readonly DecodingServices: never
	readonly EncodingServices: never
}
type ControlGroup<E extends ErrorSchema> = ReturnType<
	typeof prepare<Schema.Codec<unknown, Schema.Json>, E>
>["control"]
interface Contract<E extends ErrorSchema> {
	readonly control: ControlGroup<E>
	readonly inject: ReadonlyArray<Service>
	readonly decodeCause: (
		input: unknown,
	) => Effect.Effect<
		Cause.Cause<E["Type"] | ContractModule.UndeclaredFailure | ChildFailure>,
		Schema.SchemaError
	>
}
type Client<E extends ErrorSchema> = RpcClient.FromGroup<
	ControlGroup<E>,
	RpcClientError.RpcClientError
>
const race = <A, E, R>(
	connection: Connection["Service"],
	effect: Effect.Effect<A, E, R>,
) => Effect.raceFirst(effect, connection.transport.failure)

const forwardEvents = <E extends ErrorSchema>(
	contract: Contract<E>,
	client: Client<E>,
	connection: Connection["Service"],
) =>
	Effect.gen(function* () {
		const stopped = yield* Deferred.make<void>()
		const remoteFailure = yield* FailureGroup.make<
			| E["Type"]
			| ContractModule.UndeclaredFailure
			| ChildFailure
			| RemoteWithdrawn
		>()
		const events = yield* race(
			connection,
			client.Events().pipe(
				Stream.runForEach((event) => {
					switch (event._tag) {
						case "Stopped":
							return Deferred.succeed(stopped, undefined)
						case "Withdrawing":
							return remoteFailure.fail(RemoteWithdrawn.make({}))
						case "Failed":
							return contract
								.decodeCause(event.cause)
								.pipe(Effect.flatMap((cause) => remoteFailure.failCause(cause)))
					}
				}),
			),
		).pipe(
			Effect.tapCause(connection.transport.report),
			Effect.forkIn(connection.resources),
		)
		return { stopped, remoteFailure, events }
	})
const forwardLogs = <E extends ErrorSchema>(
	contract: Contract<E>,
	client: Client<E>,
	connection: Connection["Service"],
) =>
	Effect.gen(function* () {
		const logsEnded = yield* Deferred.make<void>()
		const reportedDrops = yield* Ref.make(0)
		yield* race(
			connection,
			client.Logs().pipe(
				Stream.runForEach((event) =>
					Effect.gen(function* () {
						const previous = yield* Ref.getAndSet(reportedDrops, event.dropped)
						if (event.dropped > previous)
							yield* Effect.logWarning("Remote logs were dropped").pipe(
								Effect.annotateLogs({
									...(Option.isSome(connection.pid)
										? { "remote.pid": connection.pid.value }
										: {}),
									"remote.logs.dropped": event.dropped - previous,
									"remote.logs.droppedTotal": event.dropped,
								}),
							)
						if (event._tag === "LogsEnded") {
							yield* Deferred.succeed(logsEnded, undefined)
							return
						}
						const entry = event.entry
						const cause = yield* contract.decodeCause(entry.cause)
						yield* Effect.logWithLevel(
							entry.level === "All" || entry.level === "None"
								? "Info"
								: entry.level,
						)(
							...(Array.isArray(entry.message)
								? entry.message
								: [entry.message]),
							cause,
						).pipe(
							Effect.annotateLogs({
								...(Option.isSome(connection.pid)
									? { "remote.pid": connection.pid.value }
									: {}),
								...(connection.threadId === undefined
									? {}
									: { "remote.threadId": connection.threadId }),
								"remote.annotations": entry.annotations,
							}),
						)
					}),
				),
			),
		).pipe(
			Effect.tapCause(connection.transport.report),
			Effect.forkIn(connection.resources),
		)
		return logsEnded
	})
export const initialize = <E extends ErrorSchema>(contract: Contract<E>) =>
	Effect.gen(function* () {
		const connection = yield* Connection
		const client = yield* RpcClient.make(contract.control).pipe(
			Effect.provideService(
				RpcClient.Protocol,
				connection.transport.clientProtocol(Control.endpoint),
			),
			Scope.provide(connection.resources),
		)
		for (const service of contract.inject)
			yield* service
				.serve(connection.transport)
				.pipe(
					Effect.tapCause(connection.transport.report),
					Effect.forkIn(connection.resources),
				)
		const events = yield* forwardEvents(contract, client, connection)
		const logsEnded = yield* forwardLogs(contract, client, connection)
		return { connection, client, ...events, logsEnded }
	})
type Active<E extends ErrorSchema> = Effect.Success<
	ReturnType<typeof initialize<E>>
>
export const load = <E extends ErrorSchema>(
	active: Active<E>,
	input: Schema.Json,
) =>
	race(
		active.connection,
		Effect.raceFirst(
			active.client
				.Load({ input })
				.pipe(
					Effect.catchIf(
						(
							cause,
						): cause is Cause.Cause<
							E["Type"] | ContractModule.UndeclaredFailure | ChildFailure
						> => Cause.isCause(cause),
						Effect.failCause,
					),
				),
			active.remoteFailure.await,
		),
	)
export const dispose = <E extends ErrorSchema>(active: Active<E>) =>
	Effect.gen(function* () {
		const result = yield* race(
			active.connection,
			active.client
				.Dispose()
				.pipe(Effect.catchIf(Cause.isCause, Effect.succeed)),
		)
		const cause = Cause.isCause(result) ? result : Cause.empty
		// A remote cleanup failure still permits the bounded event and log tail to drain.
		yield* race(
			active.connection,
			Deferred.await(active.stopped).pipe(
				Effect.andThen(Deferred.await(active.logsEnded)),
			),
		).pipe(Effect.onError(() => Effect.failCause(cleanupCause(cause))))
		return cause
	})
