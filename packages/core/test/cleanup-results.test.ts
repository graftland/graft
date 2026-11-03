import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Schema,
	Scope,
} from "effect"
import { Fork, Graft, Plugin } from "../src/index.ts"
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
				return Schema.is(Fork.CleanupError)(value)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "cleanup defect",
						apply: () =>
							Effect.addFinalizer(() =>
								Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.andThen(Effect.die("cleanup defect")),
								),
							),
					}),
				)
				yield* fork.await
				const first = yield* Effect.forkScoped(Effect.exit(fork.dispose))
				yield* Deferred.await(entered)
				const second = yield* Effect.forkScoped(Effect.exit(fork.dispose))
				yield* Deferred.succeed(release, undefined)
				const a = yield* Fiber.join(first)
				const b = yield* Fiber.join(second)
				const c = yield* Effect.exit(fork.dispose)
				assert.deepStrictEqual(a, b)
				assert.deepStrictEqual(a, c)
				assert.include(defects(a), "cleanup defect")
			}).pipe(run),
	)

	it.effect("combines startup and resource cleanup causes in Failed", () =>
		Effect.gen(function* () {
			const released = yield* Ref.make(false)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "startup and cleanup",
					apply: () =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Ref.set(released, true))
							yield* Effect.addFinalizer(() => Effect.die("cleanup defect"))
							return yield* Effect.fail("startup failure")
						}),
				}),
			)
			const exit = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) {
				assert.isTrue(
					Array.some(
						exit.cause.reasons,
						(r) => r._tag === "Fail" && r.error === "startup failure",
					),
				)
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
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "parent",
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => Ref.set(released, true))
								const child = yield* Graft.plugin(
									Plugin.make({
										name: "child",
										apply: () =>
											Effect.addFinalizer(() =>
												Effect.die("child cleanup defect"),
											),
									}),
								)
								yield* child.await
							}),
					}),
				)
				yield* parent.await
				const exit = yield* Effect.exit(parent.dispose)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "all cleanup phases",
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => Effect.die("resource cleanup"))
								yield* Plugin.fork(
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
					}),
				)
				yield* Deferred.await(applying)
				const exit = yield* Effect.exit(fork.dispose)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "cancelled waiter",
						apply: () =>
							Effect.addFinalizer(() =>
								Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.andThen(Effect.die("retained cleanup")),
								),
							),
					}),
				)
				yield* fork.await
				const first = yield* Effect.forkScoped(fork.dispose)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(first)
				yield* Deferred.succeed(release, undefined)
				const exit = yield* Effect.exit(fork.dispose)
				assert.include(defects(exit), "retained cleanup")
			}).pipe(run),
	)

	it.effect(
		"does not replay an acknowledged cleanup failure after recovery",
		() =>
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "recovering cleanup",
						config: Schema.Boolean,
						apply: (failing) =>
							failing
								? Effect.addFinalizer(() => Effect.die("old cleanup")).pipe(
										Effect.andThen(Effect.fail("old startup")),
									)
								: Effect.void,
					}),
					true,
				)
				const failed = yield* Effect.exit(fork.await)
				assert.include(defects(failed), "old cleanup")
				yield* fork.update(false)
				yield* fork.await
				const disposed = yield* Effect.exit(fork.dispose)
				assert.isTrue(Exit.isSuccess(disposed))
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
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "intercept cleanup",
					apply: () =>
						Effect.addFinalizer(() => Effect.die("intercept resource cleanup")),
				}),
				undefined,
				{ intercept: [intercept] },
			)
			yield* fork.await
			yield* Deferred.succeed(stop, undefined)
			yield* reach(fork, "Failed")
			const exit = yield* Effect.exit(fork.await)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "parent closure",
						apply: () =>
							Effect.addFinalizer(() => Effect.die("parent observed cleanup")),
					}),
				).pipe(Scope.provide(scope))
				yield* fork.await
				const parentExit = yield* Effect.exit(Scope.close(scope, Exit.void))
				const explicitExit = yield* Effect.exit(fork.dispose)
				assert.include(defects(parentExit), "parent observed cleanup")
				assert.include(defects(explicitExit), "parent observed cleanup")
			}).pipe(run),
	)

	it.effect("preserves interrupted update cleanup in the disposal result", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "update cleanup",
					config: Schema.String,
					apply: () =>
						Effect.succeed(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die("update cleanup defect")),
							),
						),
				}),
				"initial",
			)
			yield* fork.await
			const updating = yield* Effect.forkScoped(fork.update("next"))
			yield* Deferred.await(entered)
			const exit = yield* Effect.exit(fork.dispose)
			yield* Fiber.join(updating)
			assert.include(defects(exit), "update cleanup defect")
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "intercept shutdown",
						apply: () =>
							Effect.addFinalizer(() => Effect.die("activation shutdown")),
					}),
					undefined,
					{ intercept: [intercept] },
				)
				yield* fork.await
				const exit = yield* Effect.exit(fork.dispose)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "interrupted startup",
						apply: () =>
							Effect.addFinalizer(() =>
								Effect.die("interrupted startup cleanup"),
							).pipe(Effect.andThen(Effect.interrupt)),
					}),
				)
				const exit = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
				assert.include(defects(exit), "interrupted startup cleanup")
			}).pipe(run),
	)
})
