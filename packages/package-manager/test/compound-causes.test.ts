import { assert, it } from "@effect/vitest"
import { Array, Cause, Effect, Exit, Option, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { closeProcessWithTestClock as closeProcess } from "./fixtures.ts"
import { handle, run, setup, success } from "./fixtures.ts"

const error = (method: string) =>
	PlatformError.systemError({
		_tag: "Unknown",
		module: "ChildProcess",
		method,
	})
const missing = PlatformError.systemError({
	_tag: "NotFound",
	module: "ChildProcess",
	method: "kill",
	cause: { code: "ESRCH" },
})
const processWithCause = (cause: Cause.Cause<PlatformError.PlatformError>) =>
	ChildProcessSpawner.makeHandle({
		...handle(success),
		kill: () => Effect.failCause(cause),
	})

it.effect("retains the entire kill cause while the process group exists", () =>
	Effect.gen(function* () {
		const cause = Cause.combine(
			Cause.fail(error("signal")),
			Cause.fail(error("join")),
		)
		const exit = yield* Effect.exit(
			closeProcess(processWithCause(cause), {}, () => Effect.succeed(true)),
		)
		assert(Exit.isFailure(exit))
		assert.deepStrictEqual(exit.cause.reasons, cause.reasons)
	}),
)

it.effect("combines complete kill and probe causes", () =>
	Effect.gen(function* () {
		const kill = Cause.combine(
			Cause.fail(error("signal")),
			Cause.fail(error("join")),
		)
		const probe = Cause.combine(
			Cause.fail(error("probeGroup")),
			Cause.fail(error("probeCleanup")),
		)
		const exit = yield* Effect.exit(
			closeProcess(processWithCause(kill), {}, () => Effect.failCause(probe)),
		)
		assert(Exit.isFailure(exit))
		assert.deepStrictEqual(
			exit.cause.reasons,
			Cause.combine(kill, probe).reasons,
		)
	}),
)

const adapterSignal = PlatformError.systemError({
	_tag: "Unknown",
	module: "ChildProcess",
	method: "kill",
	cause: new Error("Failed to kill child process"),
})
for (const [signalLabel, signal] of [
	["ESRCH", missing],
	["Node kill fallback", adapterSignal],
] as const) {
	for (const [label, remaining] of [
		["join failure", Cause.fail(error("join"))],
		["unrecognized kill failure", Cause.fail(error("kill"))],
		["defect", Cause.die("cleanup defect")],
		["interruption", Cause.interrupt(123)],
	] as const) {
		it.effect(
			`resolves ${signalLabel} but retains a ${label} after the group disappears`,
			() =>
				Effect.gen(function* () {
					const cause = Cause.combine(Cause.fail(signal), remaining)
					const exit = yield* Effect.exit(
						closeProcess(processWithCause(cause), {}, () =>
							Effect.succeed(false),
						),
					)
					assert(Exit.isFailure(exit))
					assert.deepStrictEqual(exit.cause.reasons, remaining.reasons)
				}),
		)
	}
	it.effect(
		`resolves ${signalLabel} only when group absence is confirmed`,
		() =>
			Effect.gen(function* () {
				yield* closeProcess(processWithCause(Cause.fail(signal)), {}, () =>
					Effect.succeed(false),
				)
				const alive = yield* Effect.exit(
					closeProcess(processWithCause(Cause.fail(signal)), {}, () =>
						Effect.succeed(true),
					),
				)
				assert(Exit.isFailure(alive))
				assert.deepStrictEqual(alive.cause.reasons, Cause.fail(signal).reasons)
			}),
	)
}

it.effect("keeps all kill failures in the public recovery status", () =>
	Effect.gen(function* () {
		const { write, managerWithSpawner } = yield* setup
		yield* write("package.json", "{}")
		const signal = error("signal")
		const join = error("join")
		const cause = Cause.combine(Cause.fail(signal), Cause.fail(join))
		const pm = yield* managerWithSpawner(
			ChildProcessSpawner.make(() => Effect.succeed(processWithCause(cause))),
		)
		const exit = yield* Effect.exit(pm.install({ added: "1" }))
		assert(Exit.isFailure(exit))
		const status = yield* pm.recoveryRequired
		assert(Option.isSome(status))
		for (const expected of [signal, join]) {
			assert(
				Array.some(
					exit.cause.reasons,
					(reason) => Cause.isFailReason(reason) && reason.error === expected,
				),
			)
			assert(
				Array.some(
					status.value.recoveryCause.reasons,
					(reason) => Cause.isFailReason(reason) && reason.error === expected,
				),
			)
		}
	}).pipe(run),
)

for (const failureTag of ["PermissionDenied", "NotFound"] as const) {
	for (const missingFirst of [true, false]) {
		it.effect(
			`retains ${failureTag} cleanup alongside a missing path reported ${missingFirst ? "first" : "last"}`,
			() =>
				Effect.gen(function* () {
					const { fs, write, manager } = yield* setup
					yield* write("package.json", "{}")
					const absent = PlatformError.systemError({
						_tag: "NotFound",
						module: "FileSystem",
						method: "lstat",
					})
					const denied = PlatformError.systemError({
						_tag: failureTag,
						module: "FileSystem",
						method: "cleanup",
					})
					const cause = missingFirst
						? Cause.combine(Cause.fail(absent), Cause.fail(denied))
						: Cause.combine(Cause.fail(denied), Cause.fail(absent))
					const exit = yield* Effect.exit(
						manager(() => Effect.die("Must not install"), {
							...fs,
							lstat: () => Effect.failCause(cause),
						}),
					)
					assert(Exit.isFailure(exit))
					assert.deepStrictEqual(exit.cause.reasons, cause.reasons)
				}).pipe(run),
		)
	}
}
