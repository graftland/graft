import {
	Array,
	Cause,
	Effect,
	Exit,
	Fiber,
	Ref,
	Schedule,
	Stream,
	String,
	type PlatformError,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"

import * as FailureGroup from "../FailureGroup"

/** Time allowed for a direct execution unit or launcher to exit after input EOF. */
export const stdinExitTimeout = "1 second"

/** Readers outlive the failure monitor so forced termination still captures its diagnostic tail. */
export const observe = Effect.fnUntraced(function* (
	child: ChildProcessSpawner.ChildProcessHandle,
	options: { readonly drainStdout?: boolean } = {},
) {
	const failures = yield* FailureGroup.make<PlatformError.PlatformError>()
	const tail = yield* Ref.make("")
	// Command transports own stdout as a protocol stream.
	const stdout = yield* (
		options.drainStdout === false ? Effect.void : Stream.runDrain(child.stdout)
	).pipe(Effect.forkScoped)
	const stderr = yield* child.stderr.pipe(
		Stream.decodeText(),
		Stream.runForEach((text) =>
			Ref.update(tail, (old) => String.takeRight(old + text, 8192)),
		),
		Effect.forkScoped,
	)
	yield* failures.run(Fiber.join(stdout))
	yield* failures.run(Fiber.join(stderr))
	const exited = yield* Effect.gen(function* () {
		const result = yield* Effect.exit(child.exitCode)
		// exitCode can fail before exit on an input error; isRunning follows Node's exit event.
		yield* child.isRunning.pipe(
			Effect.repeat({
				schedule: Schedule.spaced("25 millis"),
				while: (running) => running,
			}),
		)
		const err = yield* Fiber.await(stderr)
		const out = yield* Fiber.await(stdout)
		return {
			code: Exit.isSuccess(result) ? result.value : null,
			signal: null,
			stderr: yield* Ref.get(tail),
			cause: Array.reduce(
				[Exit.asVoid(result), err, out],
				Cause.empty,
				(cause: Cause.Cause<PlatformError.PlatformError>, exit) =>
					Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause,
			),
		}
	}).pipe(Effect.forkScoped)
	return { exited: Fiber.join(exited), failure: failures.await }
})
