import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Schema,
	Scope,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { reach, run } from "./utils.ts"

const defects = (exit: Exit.Exit<unknown, unknown>): ReadonlyArray<unknown> =>
	Exit.isFailure(exit)
		? Array.flatMap(exit.cause.reasons, (reason) => {
				const value =
					reason._tag === "Die"
						? reason.defect
						: reason._tag === "Fail"
							? reason.error
							: undefined
				return Schema.is(Mount.CleanupError)(value)
					? defects(Exit.failCause(value.cause))
					: reason._tag === "Die"
						? [value]
						: []
			})
		: []

describe("activation cleanup results", () => {
	it.effect(
		"shares activation cleanup defects across concurrent and repeated disposal",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(Effect.die("cleanup defect")),
							),
						),
					),
					{ name: "cleanup defect" },
				)
				yield* mount.await
				const first = yield* Effect.forkScoped(Effect.exit(mount.unmount))
				yield* Deferred.await(entered)
				const second = yield* Effect.forkScoped(Effect.exit(mount.unmount))
				yield* Deferred.succeed(release, undefined)
				const a = yield* Fiber.join(first)
				const b = yield* Fiber.join(second)
				const c = yield* Effect.exit(mount.unmount)
				assert.deepStrictEqual(a, b)
				assert.deepStrictEqual(a, c)
				assert.include(defects(a), "cleanup defect")
			}).pipe(run),
	)

	it.effect("combines startup and resource cleanup causes in Failed", () =>
		Effect.gen(function* () {
			const released = yield* Ref.make(false)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() => Ref.set(released, true))
						yield* Effect.addFinalizer(() => Effect.die("cleanup defect"))
						return yield* Effect.fail("startup failure")
					}),
				),
				{ name: "startup and cleanup" },
			)
			const exit = yield* Effect.exit(mount.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) {
				// Effect's rule for defects: defects take precedence, so a typed failure is
				// reported as a defect when the same scope's cleanup also dies.
				assert.deepStrictEqual(
					Array.map(exit.cause.reasons, (reason) => [
						reason._tag,
						reason._tag === "Die" ? reason.defect : undefined,
					]),
					[
						["Die", "startup failure"],
						["Die", "cleanup defect"],
					],
				)
				assert.isFalse(Cause.hasFails(exit.cause))
				assert.include(defects(exit), "cleanup defect")
			}
			const didRelease = yield* Ref.get(released)
			assert.isTrue(didRelease)
		}).pipe(run),
	)

	it.effect(
		"propagates child cleanup defects through parent disposal after releasing parent resources",
		() =>
			Effect.gen(function* () {
				const released = yield* Ref.make(false)
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Ref.set(released, true))
							const child = yield* Graft.mount(
								Layer.effectDiscard(
									Effect.addFinalizer(() => Effect.die("child cleanup defect")),
								),
								{ name: "child" },
							)
							yield* child.await
						}),
					),
					{ name: "parent" },
				)
				yield* parent.await
				const exit = yield* Effect.exit(parent.unmount)
				const didRelease = yield* Ref.get(released)
				assert.isTrue(didRelease)
				assert.include(defects(exit), "child cleanup defect")
			}).pipe(run),
	)
	it.effect(
		"collects apply, task, and resource cleanup before completing disposal",
		() =>
			Effect.gen(function* () {
				const applying = yield* Deferred.make<void>()
				const taskStarted = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Effect.die("resource cleanup"))
							yield* Graft.fork(
								Deferred.succeed(taskStarted, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Effect.die("task cleanup")),
								),
							)
							yield* Deferred.await(taskStarted)
							return yield* Deferred.succeed(applying, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die("apply cleanup")),
							)
						}),
					),
					{ name: "all cleanup phases" },
				)
				yield* Deferred.await(applying)
				const exit = yield* Effect.exit(mount.unmount)
				assert.sameMembers(
					[...defects(exit)],
					["resource cleanup", "task cleanup", "apply cleanup"],
				)
			}).pipe(run),
	)

	it.effect(
		"retains the failure after the first disposal waiter is cancelled",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(Effect.die("retained cleanup")),
							),
						),
					),
					{ name: "cancelled waiter" },
				)
				yield* mount.await
				const first = yield* Effect.forkScoped(mount.unmount)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(first)
				yield* Deferred.succeed(release, undefined)
				const exit = yield* Effect.exit(mount.unmount)
				assert.include(defects(exit), "retained cleanup")
			}).pipe(run),
	)

	it.effect("adds cleanup failures to an intercept failure", () =>
		Effect.gen(function* () {
			const stop = yield* Deferred.make<void>()
			const intercept: Graft.Intercept = {
				apply: (effect) =>
					Effect.raceFirst(
						effect,
						Deferred.await(stop).pipe(
							Effect.andThen(Effect.die("intercept defect")),
						),
					),
			}
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.addFinalizer(() => Effect.die("intercept resource cleanup")),
				),
				{ name: "intercept cleanup", intercept: [intercept] },
			)
			yield* mount.await
			yield* Deferred.succeed(stop, undefined)
			yield* reach(mount, "Failed")
			const exit = yield* Effect.exit(mount.await)
			assert.sameMembers(
				[...defects(exit)],
				["intercept defect", "intercept resource cleanup"],
			)
		}).pipe(run),
	)

	it.effect(
		"observes cleanup failures through automatic parent scope closure",
		() =>
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() => Effect.die("parent observed cleanup")),
					),
					{ name: "parent closure" },
				).pipe(Scope.provide(scope))
				yield* mount.await
				const parentExit = yield* Effect.exit(Scope.close(scope, Exit.void))
				const explicitExit = yield* Effect.exit(mount.unmount)
				assert.include(defects(parentExit), "parent observed cleanup")
				assert.include(defects(explicitExit), "parent observed cleanup")
			}).pipe(run),
	)

	it.effect(
		"retains activation and intercept cleanup in the same disposal result",
		() =>
			Effect.gen(function* () {
				const intercept: Graft.Intercept = {
					apply: (effect) =>
						effect.pipe(Effect.ensuring(Effect.die("intercept shutdown"))),
				}
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() => Effect.die("activation shutdown")),
					),
					{ name: "intercept shutdown", intercept: [intercept] },
				)
				yield* mount.await
				const exit = yield* Effect.exit(mount.unmount)
				assert.sameMembers(
					[...defects(exit)],
					["intercept shutdown", "activation shutdown"],
				)
			}).pipe(run),
	)
	it.effect(
		"retains an apply interruption alongside resource cleanup failure",
		() =>
			Effect.gen(function* () {
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() =>
							Effect.die("interrupted startup cleanup"),
						).pipe(Effect.andThen(Effect.interrupt)),
					),
					{ name: "interrupted startup" },
				)
				const exit = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
				assert.include(defects(exit), "interrupted startup cleanup")
			}).pipe(run),
	)
})

it.effect("retains interruption from an intercept finalizer on unmount", () =>
	Effect.gen(function* () {
		const mount = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
			name: "interrupted intercept cleanup",
			intercept: [
				{ apply: (effect) => effect.pipe(Effect.ensuring(Effect.interrupt)) },
			],
		})
		yield* mount.await
		const exit = yield* Effect.exit(mount.unmount)
		assert(Exit.isFailure(exit))
		assert.isTrue(
			Array.some(
				exit.cause.reasons,
				(reason) =>
					reason._tag === "Fail" &&
					Schema.is(Mount.CleanupError)(reason.error) &&
					Cause.hasInterruptsOnly(reason.error.cause),
			),
		)
	}).pipe(run),
)
