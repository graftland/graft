// The spawner exposes no process-group existence check after kill loses errno.
import * as NodeProcess from "node:process"
import {
	Array,
	Cause,
	Data,
	Effect,
	Exit,
	PlatformError,
	Schedule,
	Schema,
} from "effect"
import type { ChildProcess, ChildProcessSpawner } from "effect/process"

const missingGroup = Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))
const unsignallableGroup = Schema.is(
	Schema.Struct({ code: Schema.Literal("EPERM") }),
)
// Node's kill(false) fallback loses errno, but has a specific signal-failure shape.
const failedSignal = Schema.is(
	Schema.Struct({ message: Schema.Literal("Failed to kill child process") }),
)
const isSignalFailure = (error: PlatformError.PlatformError) =>
	error.reason.module === "ChildProcess" &&
	error.reason.method === "kill" &&
	(missingGroup(error.cause) ||
		(error.reason._tag === "Unknown" && failedSignal(error.cause)))

/** Signal zero checks the group without signalling any member. */
export const groupExists = (pid: ChildProcessSpawner.ProcessId) =>
	Effect.try({
		try: () => {
			NodeProcess.kill(-pid, 0)
			return true
		},
		catch: (cause) =>
			PlatformError.systemError({
				_tag: "Unknown",
				module: "ChildProcess",
				method: "probeGroup",
				cause,
			}),
	}).pipe(
		Effect.catchIf(
			(error) => missingGroup(error.cause) || unsignallableGroup(error.cause),
			// EPERM can mean zombies on macOS. It never establishes group absence.
			(error) => Effect.succeed(!missingGroup(error.cause)),
		),
	)

/** Close the original group, including descendants that remain in it after leader exit. */
export const closeProcess = (
	process: ChildProcessSpawner.ChildProcessHandle,
	options: ChildProcess.KillOptions,
	probe: typeof groupExists = groupExists,
) =>
	Effect.gen(function* () {
		const killed = yield* Effect.suspend(() => process.kill(options)).pipe(
			Effect.exit,
		)
		// Windows retains its as-is adapter contract; POSIX requires group evidence.
		if (NodeProcess.platform === "win32") return yield* killed
		const checked = yield* Effect.suspend(() => probe(process.pid)).pipe(
			Effect.exit,
			Effect.repeat({
				while: (exit) => Exit.isSuccess(exit) && exit.value,
				times: 100,
				schedule: Schedule.spaced("20 millis"),
			}),
		)
		if (Exit.isFailure(checked))
			return yield* Effect.failCause(
				Exit.isFailure(killed)
					? Cause.combine(killed.cause, checked.cause)
					: checked.cause,
			)
		if (checked.value) {
			if (Exit.isFailure(killed)) return yield* Effect.failCause(killed.cause)
			return yield* PlatformError.systemError({
				_tag: "Unknown",
				module: "ChildProcess",
				method: "confirmGroupStopped",
				description: `Process group ${process.pid} still exists after the two-second confirmation window`,
			})
		}
		if (Exit.isFailure(killed)) {
			// Absence resolves only a failed signal to a nonexistent group, not other cleanup failures.
			const remaining = Array.filter(
				killed.cause.reasons,
				(reason) =>
					!(Cause.isFailReason(reason) && isSignalFailure(reason.error)),
			)
			if (remaining.length > 0)
				return yield* Effect.failCause(Cause.fromReasons(remaining))
		}
	})

export type Termination = Data.TaggedEnum<{
	OriginalGroupStopped: {}
	Unconfirmed: { readonly cause: Cause.Cause<PlatformError.PlatformError> }
}>

export const Termination = Data.taggedEnum<Termination>()

export type OriginalGroupStopped = Data.TaggedEnum.Value<
	Termination,
	"OriginalGroupStopped"
>

/** Only proves termination of the original group, not detached groups or daemons. */
export const terminateProcess = (
	process: ChildProcessSpawner.ChildProcessHandle,
	options: ChildProcess.KillOptions,
) =>
	Effect.suspend(() => closeProcess(process, options)).pipe(
		Effect.exit,
		Effect.map((exit): Termination =>
			Exit.isSuccess(exit)
				? Termination.OriginalGroupStopped()
				: Termination.Unconfirmed({ cause: exit.cause }),
		),
	)
