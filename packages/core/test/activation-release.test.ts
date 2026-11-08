import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Logger,
	MutableList,
	Schema,
	Scope,
} from "effect"
import { assert, it } from "@effect/vitest"

import { FinalizationInterrupted } from "../src/Finalization.ts"
import { Fork, Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

for (const phase of ["Loading", "Active"]) {
	for (const disposal of ["explicit", "parent"]) {
		for (const finalizer of ["masked", "interruptible", "self", "die"]) {
			it.effect(
				`classifies ${finalizer} release during ${disposal} disposal of ${phase}`,
				() =>
					Effect.gen(function* () {
						const logs = MutableList.make<Logger.Options<unknown>>()
						const logger = Logger.layer([
							Logger.make((entry) => {
								MutableList.append(logs, entry)
							}),
						])
						const defect = new Error("activation release failed")
						const cleanup =
							finalizer === "masked"
								? Effect.void
								: finalizer === "interruptible"
									? Effect.interruptible(Effect.void)
									: finalizer === "self"
										? Effect.interrupt
										: Effect.die(defect)
						yield* Effect.gen(function* () {
							const ready = yield* Deferred.make<void>()
							const parent = yield* Effect.acquireRelease(
								Scope.make(),
								Scope.close,
							)
							const fork = yield* Graft.plugin(
								Plugin.make({
									name: "activation release",
									apply: () =>
										Effect.addFinalizer(() => cleanup).pipe(
											Effect.andThen(Deferred.succeed(ready, undefined)),
											Effect.andThen(
												phase === "Loading" ? Effect.never : Effect.void,
											),
										),
								}),
							).pipe(Scope.provide(parent))
							yield* Deferred.await(ready)
							if (phase === "Active") yield* fork.await
							const first = yield* Effect.exit(
								disposal === "parent"
									? Scope.close(parent, Exit.void)
									: fork.dispose,
							)
							const repeated = yield* Effect.exit(fork.dispose)
							for (const result of [first, repeated]) {
								if (finalizer === "masked") {
									assert.deepStrictEqual(result, Exit.void)
								} else {
									assert(Exit.isFailure(result))
									const error = Cause.squash(result.cause)
									assert(Schema.is(Fork.CleanupError)(error))
									const released = Cause.squash(error.cause)
									if (finalizer === "self") {
										assert(Schema.is(FinalizationInterrupted)(released))
										assert.isTrue(Cause.hasInterruptsOnly(released.cause))
									} else if (finalizer === "interruptible") {
										assert.isTrue(Cause.hasInterruptsOnly(error.cause))
									} else assert.strictEqual(released, defect)
								}
							}
							if (Exit.isFailure(first) && Exit.isFailure(repeated)) {
								assert.strictEqual(
									first.cause.reasons[0]?._tag,
									disposal === "parent" ? "Die" : "Fail",
								)
								assert.strictEqual(repeated.cause.reasons[0]?._tag, "Fail")
								assert.deepStrictEqual(
									Cause.squash(first.cause),
									Cause.squash(repeated.cause),
								)
							}
						}).pipe(run, Effect.provide(logger))
						const releaseLogs = Array.filter(
							MutableList.toArray(logs),
							(entry) =>
								Array.isArray(entry.message) &&
								Array.contains(
									entry.message,
									"Releasing the plugin's resources failed",
								),
						)
						assert.strictEqual(
							releaseLogs.length,
							finalizer === "masked" ? 0 : 1,
						)
					}),
			)
		}
	}
}
