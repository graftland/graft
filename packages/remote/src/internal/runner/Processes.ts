import { Cause, Effect, Option, Schema, Stream, String } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import process from "node:process"
import { failure, type ProcessIdentity, type Termination } from "./model"

const Start = Schema.fromJsonString(
	Schema.Struct({ born: Schema.String, nonce: Schema.String }),
)
const inspect = (pid: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					"ps",
					[
						"-ww",
						"-p",
						StringFrom(pid),
						"-o",
						"lstart=",
						"-o",
						"stat=",
						"-o",
						"command=",
					],
					{
						env: { ...process.env, LC_ALL: "C" },
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
			const match = /^(.{24})\s+(\S+)\s+(.*)$/m.exec(String.trim(output))
			if (code !== 0 || match === null)
				return yield* failure(
					"Execution",
					"Cannot inspect process identity: " + stderr,
				)
			if (String.startsWith("Z")(match[2]!)) return Option.none()
			return Option.some({ born: match[1]!, command: match[3]! })
		}),
	).pipe(
		Effect.catchCause((cause) =>
			Effect.fail(
				failure("Execution", "Inspecting process identity failed", cause),
			),
		),
	)
const StringFrom = (value: number) => `${value}`

export const identity = (pid: number, nonce: string) =>
	Effect.gen(function* () {
		const current = yield* inspect(pid)
		if (
			Option.isNone(current) ||
			!String.includes(nonce)(current.value.command)
		)
			return yield* failure(
				"Execution",
				"The child exited before its identity could be recorded",
			)
		return {
			pid,
			start: yield* Schema.encodeEffect(Start)({
				born: current.value.born,
				nonce,
			}),
		}
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.fail(
				failure("Execution", "Recording process identity failed", cause),
			),
		),
	)

export const matches = (child: ProcessIdentity) =>
	Effect.gen(function* () {
		const expected = yield* Schema.decodeEffect(Start)(child.start)
		const current = yield* inspect(child.pid)
		if (Option.isNone(current) || current.value.born !== expected.born)
			return false
		// process.title can erase argv. A missing nonce with the same start time
		// is ambiguous, not evidence that the recorded execution has stopped.
		if (!String.includes(expected.nonce)(current.value.command))
			return yield* failure(
				"Unconfirmed",
				"The process start time matches but its bootstrap nonce is missing",
			)
		return true
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.fail(
				failure(
					"Unconfirmed",
					"Cannot confirm the recorded process identity",
					cause,
				),
			),
		),
	)

export const recover = (child: ProcessIdentity) =>
	Effect.gen(function* () {
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
					failure("Execution", "Signaling the orphan failed", Cause.die(cause)),
			}),
		)
		const confirmed = yield* Effect.gen(function* () {
			while (yield* matches(child)) yield* Effect.sleep("50 millis")
		}).pipe(Effect.timeoutOption("10 seconds"))
		if (Option.isNone(confirmed))
			return yield* failure(
				"Unconfirmed",
				"The orphan did not exit after recovery",
				sent._tag === "Failure" ? sent.cause : Cause.empty,
			)
		return {
			kind: "Killed",
			exit: { code: null, signal: "SIGKILL" },
			cause: sent._tag === "Failure" ? sent.cause : Cause.empty,
		} satisfies Termination
	})
