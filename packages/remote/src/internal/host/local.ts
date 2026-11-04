import { Cause, Effect, Fiber, Option, Sink, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { ProcessExited, TransportError } from "../../Errors"
import * as ProcessObservation from "../runner/ProcessObservation"

export const observe = Effect.fnUntraced(function* (
	child: ChildProcessSpawner.ChildProcessHandle,
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
	return {
		pid: Option.some(child.pid),
		exited: Fiber.join(exited),
		failure: observation.failure.pipe(
			Effect.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
		channel: {
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
	}
})
