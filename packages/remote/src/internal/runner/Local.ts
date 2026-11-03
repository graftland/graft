import {
	Array,
	Cause,
	Effect,
	Exit,
	Fiber,
	Ref,
	Sink,
	Stream,
	String,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { ProcessExited, TransportError } from "../../Errors"
import * as Port from "../port"

/** Process observers stay alive until exit, including forced cleanup. */
export const connect = Effect.fnUntraced(function* (
	child: ChildProcessSpawner.ChildProcessHandle,
	options: Port.Options,
) {
	const stderr = yield* Ref.make("")
	const err = yield* child.stderr.pipe(
		Stream.decodeText(),
		Stream.runForEach((text) =>
			Ref.update(stderr, (tail) => String.takeRight(tail + text, 8192)),
		),
		Effect.forkScoped,
	)
	const out = yield* child.stdout.pipe(Stream.runDrain, Effect.forkScoped)
	const exited = yield* Effect.gen(function* () {
		const status = yield* Effect.exit(child.exitCode)
		const exits = [
			Exit.asVoid(status),
			yield* Fiber.await(err),
			yield* Fiber.await(out),
		]
		const empty: Cause.Cause<unknown> = Cause.empty
		return ProcessExited.make({
			pid: child.pid,
			exitCode: Exit.isSuccess(status) ? status.value : null,
			stderr: yield* Ref.get(stderr),
			statusCause: Array.reduce(exits, empty, (cause, exit) =>
				Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause,
			),
		})
	}).pipe(Effect.forkScoped)
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
	const failure = yield* Effect.raceFirst(
		peer.await,
		Fiber.join(exited).pipe(Effect.flatMap(Effect.fail)),
	).pipe(Effect.forkScoped)
	const report = (cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.void
			: peer.fail(TransportError.make({ cause }))
	yield* Fiber.join(err).pipe(Effect.tapCause(report), Effect.forkScoped)
	yield* Fiber.join(out).pipe(Effect.tapCause(report), Effect.forkScoped)

	return {
		...peer,
		pid: child.pid,
		exited,
		resources: yield* Effect.scope,
		transport: { ...peer, failure: Fiber.join(failure), report },
		// The monitor's Exit is the diagnostic snapshot. Intentional termination happens after it stops.
		diagnostics: Fiber.join(exited).pipe(
			Effect.andThen(Fiber.await(failure)),
			Effect.map((exit) =>
				Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
					? exit.cause
					: Cause.empty,
			),
		),
		terminate: (graceful: boolean) =>
			Effect.gen(function* () {
				// Stop observation before intentionally ending stdin or killing the process.
				yield* Fiber.interrupt(failure)
				if (!graceful) return
				yield* peer.end
				const status = yield* Fiber.join(exited)
				if (status.exitCode !== 0 || status.statusCause.reasons.length > 0)
					return yield* status
			}),
	}
})
