import type { Plugin } from "@graftland/graft"
import * as FailureGroup from "../FailureGroup"
import {
	Cause,
	Effect,
	Duration,
	Exit,
	Fiber,
	Option,
	Ref,
	Scope,
} from "effect"
import { RpcClient } from "effect/rpc"
import {
	MtlsCredentials,
	NoCredentials,
	BearerCredentials,
	JwtCredentials,
	type PreparedCredentials,
} from "../../Auth"
import {
	WebsocketTransport,
	UnixTransport,
	CommandTransport,
} from "../../Transport"
import {
	type Authentication,
	type Runner as RunnerOptions,
} from "../../Targets"
import type { Connected } from "../runner/Connection"
import { ProcessExited, TransportError, RemoteError } from "../../Errors"
import { cleanupCause } from "../cleanup"
import * as Port from "../port"
import * as Multiplex from "../runner/Multiplex"
import * as Packages from "../runner/Packages"
import * as Wire from "../runner/Wire"
import { awaitTermination, defaults, childOf } from "../runner/model"
type RunnerTarget<D extends ReadonlyArray<Plugin.Dependency>> =
	RunnerOptions<D> & { readonly instance: string }

const prepare = Effect.fnUntraced(function* <
	D extends ReadonlyArray<Plugin.Dependency>,
>(
	auth: Authentication<D> | undefined,
): Effect.fn.Return<
	PreparedCredentials,
	RemoteError,
	| Plugin.Required<D>
	| Scope.Scope
	| MtlsCredentials
	| NoCredentials
	| BearerCredentials
	| JwtCredentials
> {
	if (auth === undefined || auth._tag === "None") {
		const encoder = yield* NoCredentials
		yield* encoder.prepare
		return {}
	}
	if (auth._tag === "Mtls") {
		const encoder = yield* MtlsCredentials
		return {
			certificate: yield* auth.read.pipe(Effect.flatMap(encoder.prepare)),
		}
	}
	const encoder = yield* auth._tag === "Bearer"
		? BearerCredentials
		: JwtCredentials
	return {
		authorization: yield* auth.read.pipe(Effect.flatMap(encoder.prepare)),
	}
})
const connectChannel = Effect.fnUntraced(function* <
	D extends ReadonlyArray<Plugin.Dependency>,
>(target: RunnerTarget<D>) {
	if (target.transport._tag === "Command") {
		const transport = yield* CommandTransport
		return yield* transport.connect(target.transport)
	}
	const credentials = yield* prepare(target.auth)
	if (target.transport._tag === "Unix") {
		const transport = yield* UnixTransport
		return yield* transport.connect(target.transport, credentials)
	}
	const transport = yield* WebsocketTransport
	return yield* transport.connect(target.transport, credentials)
})

export const connect = <D extends ReadonlyArray<Plugin.Dependency>>(
	target: RunnerTarget<D>,
	contractModule: string,
	options: Port.Options,
	resources: Scope.Scope,
	processScope: Scope.Scope,
) =>
	Effect.gen(function* () {
		const instance = target.instance

		const margin = Duration.toMillis(target.margin ?? "5 seconds")
		const channel = yield* connectChannel(target).pipe(
			Scope.provide(processScope),
		)
		const mux = yield* Multiplex.make(channel).pipe(Scope.provide(resources))
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
		const failures = yield* FailureGroup.make<TransportError>().pipe(
			Scope.provide(resources),
		)
		const finishStarted = yield* Ref.make(false)
		const terminate = yield* Effect.cached(
			Effect.gen(function* () {
				yield* Ref.set(finishStarted, true)
				yield* failures.close
				const result = yield* awaitTermination(
					record.handle,
					session.Dispose(record.handle),
					record.leaseMillis,
					margin,
				)
				const { code, signal, stderr, cause } = result.exit
				yield* Effect.logInfo("Remote execution terminated", {
					code,
					...(signal === null ? {} : { signal }),
					...(stderr === undefined || stderr === "" ? {} : { stderr }),
					...(cause === undefined || cause.reasons.length === 0
						? {}
						: { cause }),
				}).pipe(
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
			digest: target.expect?.digest !== undefined,
		})
		yield* Packages.verify(code, target.expect)
		const loaded = yield* session.Status(record.handle)
		const peer = yield* Port.make(Wire.channel(mux, 1), {
			...options,
			session: record.handle.token,
			limits: record.limits,
		}).pipe(Scope.provide(resources))
		const report = (cause: Cause.Cause<unknown>) =>
			failures.failCause(
				Cause.map(cause, (error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			)
		yield* failures.await.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: peer.fail(TransportError.make({ cause })),
			),
			Effect.forkIn(resources),
		)

		yield* failures.run(
			Fiber.join(renewed).pipe(
				Effect.catchCause((cause) =>
					Effect.gen(function* () {
						if (Cause.hasInterruptsOnly(cause)) return
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
											pid: Option.map(childOf(loaded), (child) => child.pid),
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
			),
		)
		return {
			resources,
			pid: Option.map(childOf(loaded), (child) => child.pid),
			diagnostics: failures.cause,
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
		} satisfies Connected
	})
