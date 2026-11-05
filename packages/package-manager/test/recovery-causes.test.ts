import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Ref,
	Schema,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { assert, describe, it } from "@effect/vitest"

import { PackageManagerError, RecoveryRequiredError } from "../src/index.ts"
import { run, setup } from "./fixtures.ts"

describe("recovery causes", () => {
	it.effect("retains an installer defect together with a failed recovery", () =>
		Effect.gen(function* () {
			const { write, read, manager } = yield* setup
			yield* write("package.json", "{}")
			yield* write("package-lock.json", "lock")
			const calls = yield* Ref.make(0)
			const pm = yield* manager(() =>
				Effect.gen(function* () {
					const call = yield* Ref.updateAndGet(calls, (count) => count + 1)
					yield* write("package.json", "partial")
					return call === 1
						? yield* Effect.die("installer defect")
						: ChildProcessSpawner.ExitCode(9)
				}),
			)
			const exit = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(exit))
			// Effect promotes Fail reasons to Die when a cause also contains a defect.
			const defects = Array.map(
				Array.filter(exit.cause.reasons, Cause.isDieReason),
				(reason) => reason.defect,
			)
			assert.strictEqual(defects.length, 3)
			assert.strictEqual(
				Array.filter(defects, Schema.is(RecoveryRequiredError)).length,
				1,
			)
			assert(Array.contains(defects, "installer defect"))
			const errors = Array.filter(defects, Schema.is(PackageManagerError))
			assert.strictEqual(errors.length, 1)
			for (const error of errors) assert.strictEqual(error.operation, "recover")
			const text = yield* read("package.json")
			assert.strictEqual(text, "{}")
		}).pipe(run),
	)

	it.effect(
		"retains cancellation and recovery failure after the interrupted fiber finishes",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				yield* write("package-lock.json", "lock")
				const started = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const pm = yield* manager(() =>
					Effect.gen(function* () {
						const call = yield* Ref.updateAndGet(calls, (count) => count + 1)
						if (call === 1) {
							yield* Deferred.succeed(started, undefined)
							return yield* Effect.never
						}
						yield* write("package.json", "partial recovery")
						return ChildProcessSpawner.ExitCode(9)
					}),
				)
				const fiber = yield* pm.install({ added: "1" }).pipe(Effect.forkScoped)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(fiber)
				const exit = yield* Fiber.await(fiber)
				assert(Exit.isFailure(exit))
				assert(Array.some(exit.cause.reasons, Cause.isInterruptReason))
				const error = Cause.findErrorOption(exit.cause)
				assert.strictEqual(error._tag, "Some")
				if (error._tag === "Some") {
					assert.strictEqual(error.value._tag, "PackageManagerError")
					if (error.value._tag === "PackageManagerError")
						assert.strictEqual(error.value.operation, "recover")
				}
				const status = yield* pm.recoveryRequired
				assert(Option.isSome(status))
				assert(
					Array.some(
						status.value.recoveryCause.reasons,
						Cause.isInterruptReason,
					),
				)
				const savedError = Option.getOrThrow(
					Cause.findErrorOption(status.value.recoveryCause),
				)
				assert(Schema.is(PackageManagerError)(savedError))
				assert.strictEqual(savedError.operation, "recover")
				const text = yield* read("package.json")
				assert.strictEqual(text, "{}")
			}).pipe(run),
	)
})
