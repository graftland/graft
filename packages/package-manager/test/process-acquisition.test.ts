import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	PlatformError,
	Ref,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { handle, run, setup } from "./fixtures.ts"
it.effect(
	"retains termination failure when interrupted before spawn returns",
	() =>
		Effect.gen(function* () {
			const { write, managerWithSpawner } = yield* setup
			yield* write("package.json", "{}")
			const acquired = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const killed = yield* Ref.make(false)
			const error = PlatformError.systemError({
				_tag: "Unknown",
				description: "Failed to kill child process",
				module: "ChildProcess",
				method: "kill",
			})
			const kill = Ref.set(killed, true).pipe(
				Effect.andThen(Effect.fail(error)),
			)
			const pm = yield* managerWithSpawner(
				ChildProcessSpawner.make(() =>
					Effect.uninterruptible(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => kill.pipe(Effect.ignore))
							yield* Deferred.succeed(acquired, undefined)
							yield* Deferred.await(release)
							return ChildProcessSpawner.makeHandle({
								...handle(Effect.never),
								isRunning: Effect.succeed(true),
								kill: () => kill,
							})
						}),
					),
				),
			)
			const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
			yield* Deferred.await(acquired)
			const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped)
			yield* Effect.yieldNow
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(interrupt)
			const exit = yield* Fiber.await(fiber)
			assert(Exit.isFailure(exit))
			const wasKilled = yield* Ref.get(killed)
			assert(wasKilled)

			assert(
				Array.some(
					exit.cause.reasons,
					(reason) =>
						Cause.isFailReason(reason) &&
						PlatformError.isPlatformError(reason.error) &&
						reason.error.reason.method === "kill",
				),
				"Termination error must remain in the cause",
			)
		}).pipe(run),
)

it.effect("retains process-group cleanup failure after the leader exits", () =>
	Effect.gen(function* () {
		const { write, managerWithSpawner } = yield* setup
		yield* write("package.json", "{}")
		const finalized = yield* Ref.make(false)
		const error = PlatformError.systemError({
			_tag: "Unknown",
			description: "Failed to kill child process",
			module: "ChildProcess",
			method: "kill",
		})
		const kill = Ref.set(finalized, true).pipe(
			Effect.andThen(Effect.fail(error)),
		)
		const pm = yield* managerWithSpawner(
			ChildProcessSpawner.make(() =>
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() => kill.pipe(Effect.ignore))
					return ChildProcessSpawner.makeHandle({
						...handle(Effect.succeed(ChildProcessSpawner.ExitCode(0))),
						isRunning: Effect.succeed(false),
						kill: () => kill,
					})
				}),
			),
		)
		const exit = yield* Effect.exit(pm.install({ added: "1" }))
		const wasFinalized = yield* Ref.get(finalized)
		assert(wasFinalized)

		assert(
			Exit.isFailure(exit),
			"A failed process-group cleanup must not succeed",
		)
		assert(
			Array.some(
				exit.cause.reasons,
				(reason) =>
					Cause.isFailReason(reason) &&
					PlatformError.isPlatformError(reason.error) &&
					reason.error.reason.method === "kill",
			),
		)
	}).pipe(run),
)
