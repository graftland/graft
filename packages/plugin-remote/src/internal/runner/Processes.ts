import { Cause, Effect, Option, Schedule, Stream, String } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import process from "node:process"
import {
	ExecutionError,
	TerminationUnconfirmed,
	type ProcessIdentity,
	type Termination,
} from "./model"

const inspect = Effect.fnUntraced(
	function* (pid: number) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const child = yield* spawner.spawn(
			ChildProcess.make(
				"ps",
				["-p", `${pid}`, "-o", "lstart=", "-o", "stat="],
				{
					env: { LC_ALL: "C" },
					extendEnv: true,
					stdin: "ignore",
				},
			),
		)
		const [code, output, stderr] = yield* Effect.all(
			[
				child.exitCode,
				child.stdout.pipe(Stream.decodeText(), Stream.mkString),
				child.stderr.pipe(Stream.decodeText(), Stream.mkString),
			],
			{ concurrency: "unbounded" },
		)
		if (code === 1 && String.trim(output) === "") return Option.none()
		const [, born, status] =
			/^(.{24})\s+(\S+)$/m.exec(String.trim(output)) ?? []
		if (code !== 0 || born === undefined || status === undefined)
			return yield* ExecutionError.make({
				detail: "Cannot inspect process identity: " + stderr,
			})
		if (String.startsWith("Z")(status)) return Option.none()
		return Option.some({ born })
	},
	Effect.scoped,
	Effect.mapError((error) =>
		error._tag === "ExecutionError"
			? error
			: ExecutionError.make({
					detail: "Inspecting process identity failed",
					cause: Cause.fail(error),
				}),
	),
)

export const identity = Effect.fnUntraced(function* (pid: number) {
	const current = yield* inspect(pid)
	if (Option.isNone(current))
		return yield* ExecutionError.make({
			detail: "The child exited before its identity could be recorded",
		})
	return { pid, start: current.value }
})

// The OS may discard argv before reporting a zombie; PID and start time remain the identity.
export const matches = Effect.fnUntraced(function* (child: ProcessIdentity) {
	const current = yield* inspect(child.pid)
	if (Option.isNone(current) || current.value.born !== child.start.born)
		return false
	return true
})

export const recover = Effect.fnUntraced(function* (child: ProcessIdentity) {
	if (!(yield* matches(child)))
		return {
			kind: "Exited",
			exit: { code: null, signal: null },
			cause: Cause.empty,
		} satisfies Termination
	// The PID can still be reused between this final check and kill; an external supervisor covers descendants.
	const sent = yield* Effect.exit(
		Effect.try({
			try: () => process.kill(child.pid, "SIGKILL"),
			catch: (cause) =>
				ExecutionError.make({
					detail: "Signaling the orphan failed",
					cause: Cause.die(cause),
				}),
		}),
	)
	const confirmed = yield* matches(child).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("50 millis"),
			while: (value) => value,
		}),
		Effect.timeoutOption("10 seconds"),
	)
	if (Option.isNone(confirmed))
		return yield* TerminationUnconfirmed.make({
			detail: "The orphan did not exit after recovery",
			cause: sent._tag === "Failure" ? sent.cause : Cause.empty,
		})
	return {
		kind: "Killed",
		exit: { code: null, signal: "SIGKILL" },
		cause: sent._tag === "Failure" ? sent.cause : Cause.empty,
	} satisfies Termination
})
