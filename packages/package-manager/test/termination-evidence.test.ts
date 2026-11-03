import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Effect,
	Exit,
	Fiber,
	Option,
	PlatformError,
	Ref,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { closeProcess } from "../src/process.ts"
import { handle, run, setup, success } from "./fixtures.ts"

it.effect("waits for a briefly lingering group after kill succeeds", () =>
	Effect.gen(function* () {
		const probes = yield* Ref.make(0)
		const fiber = yield* closeProcess(handle(success), {}, () =>
			Ref.updateAndGet(probes, (n) => n + 1).pipe(Effect.map((n) => n < 4)),
		).pipe(Effect.forkScoped)
		yield* TestClock.adjust("40 millis")
		const early = yield* Effect.sync(() => fiber.pollUnsafe())
		assert.strictEqual(
			early,
			undefined,
			"A lingering group must not be declared stopped",
		)
		yield* TestClock.adjust("20 millis")
		yield* Fiber.join(fiber)
		const count = yield* Ref.get(probes)
		assert.strictEqual(count, 4)
	}).pipe(Effect.scoped),
)

it.effect("bounds confirmation when kill succeeds but the group remains", () =>
	Effect.gen(function* () {
		const probes = yield* Ref.make(0)
		const fiber = yield* closeProcess(handle(success), {}, () =>
			Ref.update(probes, (n) => n + 1).pipe(Effect.as(true)),
		).pipe(Effect.forkScoped)
		yield* TestClock.adjust("2 seconds")
		const exit = yield* Fiber.await(fiber)
		assert(Exit.isFailure(exit))
		assert(
			Array.some(
				exit.cause.reasons,
				(reason) =>
					Cause.isFailReason(reason) &&
					reason.error.reason.method === "confirmGroupStopped",
			),
		)
		const count = yield* Ref.get(probes)
		assert.strictEqual(count, 101)
	}).pipe(Effect.scoped),
)

it.effect("retains the complete probe cause after a successful kill", () =>
	Effect.gen(function* () {
		const error = (method: string) =>
			PlatformError.systemError({
				_tag: "Unknown",
				module: "ChildProcess",
				method,
			})
		const cause = Cause.combine(
			Cause.fail(error("probeGroup")),
			Cause.fail(error("probeCleanup")),
		)
		const exit = yield* Effect.exit(
			closeProcess(handle(success), {}, () => Effect.failCause(cause)),
		)
		assert(Exit.isFailure(exit))
		assert.deepStrictEqual(exit.cause.reasons, cause.reasons)
	}),
)

it.live(
	"quarantines a live group even when the injected kill reports success",
	() =>
		Effect.gen(function* () {
			const { write, read, fs, managerWithSpawner } = yield* setup
			yield* write("package.json", "{}")
			const real = yield* ChildProcessSpawner.ChildProcessSpawner
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make((command) => {
					if (command._tag !== "StandardCommand")
						return Effect.die("Unexpected pipeline")
					return real
						.spawn(
							ChildProcess.make(
								"node",
								["-e", "setTimeout(() => process.exit(0), 10000)"],
								command.options,
							),
						)
						.pipe(
							Effect.map((process) =>
								ChildProcessSpawner.makeHandle({
									...process,
									exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(7)),
									kill: () => Effect.void,
								}),
							),
						)
				}),
			)
			const exit = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(exit))
			const status = yield* pm.recoveryRequired
			assert(Option.isSome(status))
			const snapshotExists = yield* fs.exists(status.value.snapshotDirectory)
			assert.strictEqual(snapshotExists, true)
			const current = yield* read("package.json")
			assert.strictEqual(
				current,
				'{"dependencies": {"added": "1"}}',
				"Rollback must wait for proof that the group is gone",
			)
			const retry = yield* Effect.exit(pm.install({ next: "2" }))
			assert(Exit.isFailure(retry))
		}).pipe(run),
	10000,
)

it.live(
	"rolls back ordinary installer failures without requiring manual recovery",
	() =>
		Effect.gen(function* () {
			const { write, read, managerWithSpawner } = yield* setup
			yield* write("package.json", "{}")
			const real = yield* ChildProcessSpawner.ChildProcessSpawner
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make((command) => {
					if (command._tag !== "StandardCommand")
						return Effect.die("Unexpected pipeline")
					return real.spawn(
						ChildProcess.make(
							"node",
							["-e", "process.exit(7)"],
							command.options,
						),
					)
				}),
			)
			for (let attempt = 0; attempt < 3; attempt++) {
				const exit = yield* Effect.exit(pm.install({ added: "1" }))
				assert(Exit.isFailure(exit))
				const status = yield* pm.recoveryRequired
				assert(Option.isNone(status))
				const current = yield* read("package.json")
				assert.strictEqual(current, "{}")
			}
		}).pipe(run),
)
