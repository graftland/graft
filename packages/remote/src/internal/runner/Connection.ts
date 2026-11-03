import {
	Array,
	Cause,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Ref,
	Scope,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcGroup, type RpcClientError } from "effect/rpc"
import type { Target } from "../../Targets"
import { ProcessExited, TransportError } from "../../Errors"
import { cleanupCause } from "../cleanup"
import * as Services from "../services"
import type { Schema } from "effect"
import type { SessionError, RemoteTerminationUnconfirmed } from "./model"
import * as Duplex from "../duplex"
import * as Transport from "../transport"
import * as Multiplex from "./Multiplex"
import * as Packages from "./Packages"
import * as Tls from "./Tls"
import * as Wire from "./Wire"
import { awaitTermination, defaults, failure } from "./model"
import { command } from "./command"

type Peer = Effect.Success<ReturnType<typeof Duplex.make>>
interface Connected {
	readonly pid: number
	readonly diagnostics: Effect.Effect<Cause.Cause<unknown>>
	readonly terminate: (
		graceful: boolean,
	) => Effect.Effect<
		void,
		| ProcessExited
		| TransportError
		| Schema.SchemaError
		| SessionError
		| RemoteTerminationUnconfirmed
		| RpcClientError.RpcClientError
	>
	readonly transport: {
		readonly protocol: Peer["clientProtocol"]
		readonly serverProtocol: Peer["serverProtocol"]
		readonly failure: Effect.Effect<never, ProcessExited | TransportError>
		readonly report: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
	}
}
const connected = (value: Connected): Connected => value

export const open = (
	target: Target,
	contractModule: string,
	instance: string | undefined,
	options: Duplex.Options,
	resources: Scope.Scope,
	processScope: Scope.Scope,
) =>
	Effect.gen(function* () {
		if (target._tag === "Local") {
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
			const transport = yield* Transport.make(child, options).pipe(
				Scope.provide(resources),
			)
			return connected({
				pid: child.pid,
				transport: { ...transport, failure: Deferred.await(transport.failed) },
				diagnostics: Fiber.join(transport.exited).pipe(
					Effect.andThen(Ref.get(transport.failures)),
				),
				terminate: (graceful) =>
					Effect.gen(function* () {
						yield* Ref.set(transport.stopping, true)
						if (!graceful) return
						yield* transport.end
						const status = yield* Fiber.join(transport.exited)
						if (status.exitCode !== 0 || status.statusCause.reasons.length > 0)
							return yield* status
					}),
			})
		}
		if (instance === undefined || instance.length === 0)
			return yield* failure(
				"InvalidRequest",
				"A runner target requires an explicit instance id",
			)
		const socket = yield* Tls.connect({
			...target,
			servername: target.tls.servername,
		}).pipe(Scope.provide(processScope))
		const mux = yield* Multiplex.fromSocket(socket).pipe(
			Scope.provide(resources),
		)
		const control = yield* Duplex.make(Wire.channel(mux, 0), {
			session: "session-v1",
			local: Services.combine(RpcGroup.make(), []),
			remote: Services.combine(Wire.Session, []),
		}).pipe(Scope.provide(resources))
		const session = yield* RpcClient.make(Wire.Session).pipe(
			Effect.provideService(RpcClient.Protocol, control.clientProtocol),
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
						leaseMillis: Duration.toMillis(
							Duration.fromInputUnsafe(target.lease),
						),
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
					Duration.toMillis(
						Duration.fromInputUnsafe(target.margin ?? "5 seconds"),
					),
				)
				yield* Effect.logInfo("Remote execution terminated", result.exit).pipe(
					Effect.annotateLogs({
						"remote.instance": record.handle.key.instance,
						"remote.generation": record.handle.generation,
						"remote.termination": result.kind,
					}),
				)
				if (result.cause.reasons.length > 0)
					return yield* Effect.failCause(result.cause)
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
		const peer = yield* Duplex.make(Wire.channel(mux, 1), {
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
					if (
						Exit.isSuccess(status) &&
						status.value.termination !== undefined
					) {
						const exit = status.value.termination.exit
						yield* report(
							Cause.combine(
								cause,
								Cause.fail(
									ProcessExited.make({
										pid: loaded.child?.pid ?? 0,
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
			pid: loaded.child?.pid ?? 0,
			diagnostics: Ref.get(failures),
			terminate: () =>
				Effect.gen(function* () {
					// No renewal may extend a disconnected session while termination waits out its lease.
					yield* Fiber.interrupt(renewed)
					yield* terminate
				}),
			transport: {
				...peer,
				protocol: peer.clientProtocol,
				failure: Deferred.await(peer.failed),
				report,
			},
		})
	})
