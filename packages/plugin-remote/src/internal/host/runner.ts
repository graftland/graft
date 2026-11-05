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
import { connectWith as connectCapability } from "../assembly"
import type { ConfiguredRunner, Connected } from "../runner/Connection"
import { ProcessExited, TransportError } from "../../Errors"
import { cleanupCause } from "../cleanup"
import * as Port from "../port"
import * as Multiplex from "../runner/Multiplex"
import * as Packages from "../runner/Packages"
import * as Wire from "../runner/Wire"
import { awaitTermination, defaults, childOf } from "../runner/model"
export const connect = Effect.fnUntraced(function* (
	target: ConfiguredRunner,
	contractModule: string,
	options: Port.Options,
	resources: Scope.Scope,
	processScope: Scope.Scope,
) {
	const instance = target.instance

	const margin = Duration.toMillis(target.margin ?? "5 seconds")
	const channel = yield* connectCapability(target.explicitAuth).pipe(
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
			// A failed close must not skip Dispose; both outcomes are reported together below.
			const closed = yield* Effect.exit(failures.close)
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
				...(cause === undefined || cause.reasons.length === 0 ? {} : { cause }),
			}).pipe(
				Effect.annotateLogs({
					"remote.instance": record.handle.key.instance,
					"remote.generation": record.handle.generation,
					"remote.termination": result.kind,
				}),
			)
			const failure = Exit.isFailure(closed)
				? Cause.combine(closed.cause, result.cause)
				: result.cause
			if (failure.reasons.length > 0)
				return yield* Effect.failCause(cleanupCause(failure))
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
	// RPC forwarding cancellation is expected; resource cleanup is collected by Connection's scopes.
	const report = (cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.void
			: failures.failCause(
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
			Effect.catchCause(
				Effect.fnUntraced(function* (cause) {
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
		terminate: Effect.fnUntraced(function* () {
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
