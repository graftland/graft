import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Layer,
	Logger,
	MutableList,
	Schema,
	Scope,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Mount, Release } from "../src/index.ts"
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
							const mount = yield* Graft.mount(
								Layer.effectDiscard(
									Effect.addFinalizer(() => cleanup).pipe(
										Effect.andThen(Deferred.succeed(ready, undefined)),
										Effect.andThen(
											phase === "Loading" ? Effect.never : Effect.void,
										),
									),
								),
								{ name: "activation release" },
							).pipe(Scope.provide(parent))
							yield* Deferred.await(ready)
							if (phase === "Active") yield* mount.await
							const first = yield* Effect.exit(
								disposal === "parent"
									? Scope.close(parent, Exit.void)
									: mount.unmount,
							)
							const repeated = yield* Effect.exit(mount.unmount)
							for (const result of [first, repeated]) {
								if (finalizer === "masked" || finalizer === "interruptible") {
									assert.deepStrictEqual(result, Exit.void)
								} else {
									assert(Exit.isFailure(result))
									const error = Cause.squash(result.cause)
									assert(Schema.is(Mount.CleanupError)(error))
									const released = Cause.squash(error.cause)
									if (finalizer === "self") {
										if (phase === "Active") {
											assert(Schema.is(Release.ReleaseInterrupted)(released))
											assert.isTrue(Cause.hasInterruptsOnly(released.cause))
										} else {
											// A loading mount is built inside its layer's scope; interrupting that
											// build at disposal leaves the finalizer's self-interrupt and the
											// build's own interruption as plain interrupt reasons.
											assert.deepStrictEqual(
												Array.map(error.cause.reasons, (reason) => reason._tag),
												["Interrupt", "Interrupt"],
											)
											assert.isTrue(Cause.hasInterruptsOnly(error.cause))
											assert.isFalse(
												Schema.is(Release.ReleaseInterrupted)(released),
											)
										}
									} else if (phase === "Active") {
										assert.strictEqual(released, defect)
									} else {
										// A finalizer that dies during a loading layer build is reported after
										// the build's own interruption, so both reasons are retained.
										assert.deepStrictEqual(
											Array.map(error.cause.reasons, (reason) => reason._tag),
											["Interrupt", "Die"],
										)
										assert.isTrue(
											Array.some(
												error.cause.reasons,
												(reason) =>
													reason._tag === "Die" && reason.defect === defect,
											),
										)
										assert.strictEqual(released, defect)
									}
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
									"Releasing the mount's resources failed",
								),
						)
						// A still-loading mount is disposed through its layer build scope, so its
						// release failures are only logged for a dying finalizer; Active mounts
						// log both interrupted and dying releases.
						assert.strictEqual(
							releaseLogs.length,
							finalizer === "die" ||
								(phase === "Active" && finalizer === "self")
								? 1
								: 0,
						)
						if (finalizer === "die") {
							assert.isTrue(
								Array.some(
									releaseLogs[0]!.cause.reasons,
									(reason) => reason._tag === "Die" && reason.defect === defect,
								),
							)
						}
					}),
			)
		}
	}
}
