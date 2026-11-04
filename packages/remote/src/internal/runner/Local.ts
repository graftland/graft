import { Cause, Effect, Fiber, Option } from "effect"
import type { Execution } from "../../Transport"
import * as FailureGroup from "../FailureGroup"
import {
	LocalTerminationTimeout,
	ProcessExited,
	TransportError,
} from "../../Errors"
import * as Port from "../port"
import { stdinExitTimeout } from "./ProcessObservation"

/** Process observers stay alive until exit, including forced cleanup. */
export const connect = Effect.fnUntraced(function* (
	execution: Execution,
	options: Port.Options,
) {
	const failures = yield* FailureGroup.make<ProcessExited | TransportError>()
	const exited = yield* execution.exited.pipe(Effect.forkScoped)
	const peer = yield* Port.make(execution.channel, options)
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
	yield* failures.run(execution.failure)

	return {
		...peer,
		pid: Option.some(execution.pid),
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
						duration: stdinExitTimeout,
						orElse: () => LocalTerminationTimeout.make({ pid: execution.pid }),
					}),
				)
				if (status.exitCode !== 0 || status.statusCause.reasons.length > 0)
					return yield* status
			}),
	}
})
