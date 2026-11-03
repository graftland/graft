import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Stream,
	String,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import * as Port from "./port"
import { Sink } from "effect"
import { ProcessExited, TransportError } from "../Errors"

/** One client and one process per activation; EOF is resolved by the exit observer. */
export const make = Effect.fnUntraced(function* (
	child: ChildProcessSpawner.ChildProcessHandle,
	options: Port.Options,
) {
	const failed = yield* Deferred.make<never, ProcessExited | TransportError>()
	const stopping = yield* Ref.make(false)
	const failures = yield* Ref.make<Cause.Cause<ProcessExited | TransportError>>(
		Cause.empty,
	)
	const stderr = yield* Ref.make("")
	const record = (error: ProcessExited | TransportError) =>
		Effect.gen(function* () {
			yield* Ref.update(failures, (cause) =>
				Cause.combine(cause, Cause.fail(error)),
			)
			yield* Deferred.fail(failed, error)
		})
	const report = (cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.void
			: record(TransportError.make({ cause }))
	const stderrFiber = yield* child.stderr.pipe(
		Stream.decodeText(),
		Stream.runForEach((text) =>
			Ref.update(stderr, (tail) => String.takeRight(tail + text, 8192)),
		),
		Effect.tapCause(report),
		Effect.forkScoped,
	)
	const stdoutFiber = yield* child.stdout.pipe(
		Stream.runDrain,
		Effect.tapCause(report),
		Effect.forkScoped,
	)
	const exited = yield* Effect.gen(function* () {
		const status = yield* Effect.exit(child.exitCode)
		const err = yield* Fiber.await(stderrFiber)
		const out = yield* Fiber.await(stdoutFiber)
		const empty: Cause.Cause<unknown> = Cause.empty
		const statusCause = Array.reduce(
			[Exit.asVoid(status), err, out],
			empty,
			(cause, exit) =>
				Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause,
		)
		const error = ProcessExited.make({
			pid: child.pid,
			exitCode: Exit.isSuccess(status) ? status.value : null,
			stderr: yield* Ref.get(stderr),
			statusCause,
		})
		if (!(yield* Ref.get(stopping))) yield* record(error)
		return error
	}).pipe(Effect.forkScoped)
	const peer = yield* Port.make(
		{
			input: child.getOutputFd(3).pipe(
				// A process exit closes fd 3 before Node reports its status. Let the exit
				// observer publish complete diagnostics first, without waiting forever
				// if a live process closes only its protocol descriptor.
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
	yield* peer.await.pipe(
		Effect.catchCause((cause) =>
			Ref.get(stopping).pipe(
				Effect.flatMap((stopping) => (stopping ? Effect.void : report(cause))),
			),
		),
		Effect.forkScoped,
	)
	return {
		...peer,
		report: (cause: Cause.Cause<unknown>) =>
			Ref.get(stopping).pipe(
				Effect.flatMap((stopping) => (stopping ? Effect.void : report(cause))),
			),
		failures,
		failed,
		stopping,
		exited,
		end: peer.end,
	}
})
