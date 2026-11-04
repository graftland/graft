import { Cause, Effect, Fiber, Option, Sink, Stream } from "effect"
import * as ProcessObservation from "./ProcessObservation"
import * as FailureGroup from "../FailureGroup"
import type { ChildProcessSpawner } from "effect/process"
import {
	LocalTerminationTimeout,
	ProcessExited,
	TransportError,
} from "../../Errors"
import * as Port from "../port"

/** Process observers stay alive until exit, including forced cleanup. */
export const connect = Effect.fnUntraced(function* (
	child: ChildProcessSpawner.ChildProcessHandle,
	options: Port.Options,
) {
	const observation = yield* ProcessObservation.observe(child)
	const exited = yield* observation.exited.pipe(
		Effect.mapBoth({
			onFailure: (error) => TransportError.make({ cause: Cause.fail(error) }),
			onSuccess: (status) =>
				ProcessExited.make({
					pid: Option.some(child.pid),
					exitCode: status.code,
					stderr: status.stderr,
					statusCause: status.cause,
				}),
		}),
		Effect.forkScoped,
	)
	const failures = yield* FailureGroup.make<ProcessExited | TransportError>()
	const peer = yield* Port.make(
		{
			input: child.getOutputFd(3).pipe(
				// EOF can precede Node's exit event; prefer complete process diagnostics.
				Stream.concat(
					Stream.fromEffect(
						Fiber.join(exited).pipe(
							Effect.timeoutOption("1 second"),
							Effect.asVoid,
						),
					).pipe(Stream.drain),
				),
				Stream.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			),
			output: child.stdin.pipe(
				Sink.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			),
		},
		options,
	)
	yield* failures.run(
		Effect.raceFirst(
			peer.await,
			Fiber.join(exited).pipe(Effect.flatMap(Effect.fail)),
		),
	)
	const report = (cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.void
			: failures
					.fail(TransportError.make({ cause }))
					.pipe(Effect.andThen(peer.fail(TransportError.make({ cause }))))
	yield* failures.run(
		observation.failure.pipe(
			Effect.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
	)

	return {
		...peer,
		pid: Option.some(child.pid),
		exited,
		resources: yield* Effect.scope,
		transport: { ...peer, failure: failures.await, report },
		diagnostics: Fiber.await(exited).pipe(Effect.andThen(failures.cause)),
		terminate: (graceful: boolean) =>
			Effect.gen(function* () {
				// Stop observation before intentionally ending stdin or killing the process.
				yield* failures.close
				if (!graceful) return
				// If this fails, the enclosing process scope signals, escalates, and waits for exit.
				const status = yield* peer.end.pipe(
					Effect.andThen(Fiber.join(exited)),
					Effect.interruptible,
					Effect.timeoutOrElse({
						duration: "1 second",
						orElse: () => LocalTerminationTimeout.make({ pid: child.pid }),
					}),
				)
				if (status.exitCode !== 0 || status.statusCause.reasons.length > 0)
					return yield* status
			}),
	}
})
