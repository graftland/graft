import {
	Array,
	Cause,
	Context,
	Effect,
	Duration,
	Exit,
	Fiber,
	Option,
	Ref,
	Scope,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, type RpcClientError } from "effect/rpc"
import type { Schema } from "effect"
import type { RemoteTerminationUnconfirmed } from "./model"
import type {
	Target,
	Local as LocalTarget,
	Runner as RunnerTarget,
} from "../../Targets"
import { ProcessExited, TransportError } from "../../Errors"
import { cleanupCause } from "../cleanup"
import * as Port from "../port"
import * as LocalProcess from "./Local"
import * as Multiplex from "./Multiplex"
import * as Packages from "./Packages"
import * as Tls from "./Tls"
import * as Wire from "./Wire"
import { awaitTermination, defaults, childOf } from "./model"
import { command } from "./command"

type Peer = Effect.Success<ReturnType<typeof Port.make>>
export interface Connected {
	readonly resources: Scope.Scope
	readonly pid: number
	readonly diagnostics: Effect.Effect<Cause.Cause<unknown>>
	readonly terminate: (
		graceful: boolean,
	) => Effect.Effect<
		void,
		| ProcessExited
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
	"@graftland/remote/internal/runner/Connection",
) {}
const connected = Connection.of

export const Local = (
	target: LocalTarget,
	contractModule: string,
	options: Port.Options,
	resources: Scope.Scope,
	processScope: Scope.Scope,
) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const argv = yield* command(target.command)
		const child = yield* spawner
			.spawn(
				ChildProcess.make(
					argv[0],
					[...Array.drop(argv, 1), contractModule, options.session],
					{
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
						additionalFds: { fd3: { type: "output" } },
						forceKillAfter: "1 second",
					},
				),
			)
			.pipe(Scope.provide(processScope))
		return yield* LocalProcess.connect(child, options).pipe(
			Scope.provide(resources),
		)
	})

export const Runner = (
	target: RunnerTarget,
	contractModule: string,
	options: Port.Options,
	resources: Scope.Scope,
	processScope: Scope.Scope,
) =>
	Effect.gen(function* () {
		const instance = target.instance

		const margin = Duration.toMillis(target.margin ?? "5 seconds")
		const socket = yield* Tls.connect({
			...target,
			servername: target.tls.servername,
		}).pipe(Scope.provide(processScope))
		const mux = yield* Multiplex.fromSocket(socket).pipe(
			Scope.provide(resources),
		)
		const control = yield* Port.make(Wire.channel(mux, 0), {
			session: "session-v1",
			serve: {},
			call: { session: Wire.Session },
		}).pipe(Scope.provide(resources))
		const session = yield* RpcClient.make(Wire.Session).pipe(
			Effect.provideService(
				RpcClient.Protocol,
				control.clientProtocol("session"),
			),
			Scope.provide(resources),
		)
		const expectedGeneration = yield* session.HighWater({ instance })
		const record = yield* session.Open({
			instance,
			expectedGeneration,
			requestId: options.session,
			limits: defaults,
			...(target.lease === undefined
				? {}
				: {
						leaseMillis: Duration.toMillis(target.lease),
					}),
		})
		const stopping = yield* Ref.make(false)
		const failures = yield* Ref.make<Cause.Cause<TransportError>>(Cause.empty)
		const finishStarted = yield* Ref.make(false)
		const terminate = yield* Effect.cached(
			Effect.gen(function* () {
				yield* Ref.set(finishStarted, true)
				yield* Ref.set(stopping, true)
				const result = yield* awaitTermination(
					record.handle,
					session.Dispose(record.handle),
					record.leaseMillis,
					margin,
				)
				yield* Effect.logInfo("Remote execution terminated", result.exit).pipe(
					Effect.annotateLogs({
						"remote.instance": record.handle.key.instance,
						"remote.generation": record.handle.generation,
						"remote.termination": result.kind,
					}),
				)
				if (result.cause.reasons.length > 0)
					return yield* Effect.failCause(cleanupCause(result.cause))
			}),
		)
		yield* Scope.addFinalizer(
			processScope,
			Effect.gen(function* () {
				if (!(yield* Ref.get(finishStarted)))
					yield* terminate.pipe(
						Effect.catchCause((cause) => Effect.failCause(cleanupCause(cause))),
					)
			}),
		)
		const renewed = yield* Effect.forever(
			Effect.sleep(record.leaseMillis / 3).pipe(
				Effect.andThen(session.Renew(record.handle)),
			),
		).pipe(Effect.forkIn(resources))
		const code = yield* session.Load({
			handle: record.handle,
			specifier: contractModule,
		})
		yield* Packages.verify(code, target.expect)
		const loaded = yield* session.Status(record.handle)
		const peer = yield* Port.make(Wire.channel(mux, 1), {
			...options,
			session: record.handle.token,
			limits: record.limits,
		}).pipe(Scope.provide(resources))
		const report = (cause: Cause.Cause<unknown>) =>
			Effect.gen(function* () {
				if (Cause.hasInterruptsOnly(cause) || (yield* Ref.get(stopping))) return
				const error = TransportError.make({ cause })
				yield* Ref.update(failures, (current) =>
					Cause.combine(current, Cause.fail(error)),
				)
				yield* peer.fail(error)
			})
		yield* Fiber.join(renewed).pipe(
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					if (yield* Ref.get(stopping)) return
					const status = yield* Effect.exit(
						session.Status(record.handle).pipe(Effect.timeout("5 seconds")),
					)
					if (Exit.isSuccess(status) && status.value.phase === "Stopped") {
						const exit = status.value.termination.exit
						yield* report(
							Cause.combine(
								cause,
								Cause.fail(
									ProcessExited.make({
										pid: Option.getOrUndefined(childOf(loaded))?.pid ?? 0,
										exitCode: exit.code,
										stderr: exit.stderr ?? "",
										statusCause: exit.cause ?? Cause.empty,
									}),
								),
							),
						)
					} else
						yield* report(
							Exit.isFailure(status)
								? Cause.combine(cause, status.cause)
								: cause,
						)
				}),
			),
			Effect.forkIn(resources),
		)
		return connected({
			resources,
			pid: Option.getOrUndefined(childOf(loaded))?.pid ?? 0,
			diagnostics: Ref.get(failures),
			terminate: () =>
				Effect.gen(function* () {
					// No renewal may extend a disconnected session while termination waits out its lease.
					yield* Fiber.interrupt(renewed)
					yield* terminate
				}),
			transport: {
				...peer,
				failure: peer.await,
				report,
			},
		})
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
				return target._tag === "Local"
					? yield* Local(
							target,
							contractModule,
							options,
							owned.resources,
							owned.process,
						).pipe(Effect.map(connected))
					: yield* Runner(
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
