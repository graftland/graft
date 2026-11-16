import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Scope,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { ownedScope } from "../src/internal/scope.ts"
import { run } from "./utils.ts"

describe("mount close completion", () => {
	it.effect("makes every concurrent unmount wait for cleanup", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const cleaned = yield* Ref.make(false)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.addFinalizer(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(Ref.set(cleaned, true)),
						),
					),
				),
				{ name: "slow cleanup" },
			)
			yield* mount.await
			const first = yield* Effect.forkScoped(mount.unmount)
			yield* Deferred.await(entered)
			const second = yield* Effect.forkScoped(mount.unmount)
			yield* TestClock.adjust("1 millis")
			const early = second.pollUnsafe() !== undefined
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
			const completed = yield* Ref.get(cleaned)
			assert.isFalse(early)
			assert.isTrue(completed)
		}).pipe(run),
	)

	it.effect(
		"keeps parent resources alive until an independently unmounted child finishes",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const handle = yield* Deferred.make<Mount.Mount>()
				const alive = yield* Ref.make(false)
				const observed = yield* Ref.make(false)
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.acquireRelease(Ref.set(alive, true), () =>
								Ref.set(alive, false),
							)
							const child = yield* Graft.mount(
								Layer.effectDiscard(
									Effect.addFinalizer(() =>
										Deferred.succeed(entered, undefined).pipe(
											Effect.andThen(Deferred.await(release)),
											Effect.andThen(
												Effect.flatMap(Ref.get(alive), (value) =>
													Ref.set(observed, value),
												),
											),
										),
									),
								),
								{ name: "child" },
							)
							yield* child.await
							yield* Deferred.succeed(handle, child)
						}),
					),
					{ name: "parent" },
				)
				yield* parent.await
				const child = yield* Deferred.await(handle)
				const closingChild = yield* Effect.forkScoped(child.unmount)
				yield* Deferred.await(entered)
				const closingParent = yield* Effect.forkScoped(parent.unmount)
				yield* TestClock.adjust("1 millis")
				const premature = closingParent.pollUnsafe() !== undefined
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(closingChild)
				yield* Fiber.join(closingParent)
				const wasAlive = yield* Ref.get(observed)
				assert.isFalse(premature)
				assert.isTrue(wasAlive)
			}).pipe(run),
	)

	it.effect("allows a background fiber to unmount its own mount", () =>
		Effect.gen(function* () {
			const handle = yield* Deferred.make<Mount.Mount>()
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Graft.fork(
						Effect.yieldNow.pipe(
							Effect.andThen(
								Effect.flatMap(
									Deferred.await(handle),
									(mount) => mount.unmount,
								),
							),
						),
					).pipe(Effect.asVoid),
				),
				{ name: "self stopping" },
			)
			yield* Deferred.succeed(handle, mount)
			yield* mount.await
			yield* Effect.yieldNow
			yield* mount.unmount
			const snapshot = yield* Stream.runHead(mount.state)
			assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Unmounted")
		}).pipe(run),
	)
	it.effect(
		"finishes cleanup after the first unmount caller is cancelled",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const cleaned = yield* Ref.make(false)
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(Ref.set(cleaned, true)),
							),
						),
					),
					{ name: "cancelled unmount" },
				)
				yield* mount.await
				const first = yield* Effect.forkScoped(mount.unmount)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(first)
				const second = yield* Effect.forkScoped(mount.unmount)
				yield* TestClock.adjust("1 millis")
				const early = second.pollUnsafe() !== undefined
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(second)
				assert.isFalse(early)
				const complete = yield* Ref.get(cleaned)
				assert.isTrue(complete)
			}).pipe(run),
	)

	it.effect("shares the complete cleanup cause with every closer", () =>
		Effect.gen(function* () {
			const parent = yield* Scope.make()
			const owned = yield* ownedScope(parent)
			yield* Scope.addFinalizer(owned.scope, Effect.die("first cleanup defect"))
			yield* Scope.addFinalizer(
				owned.scope,
				Effect.die("second cleanup defect"),
			)
			const first = yield* Effect.exit(owned.close(Exit.void))
			const second = yield* Effect.exit(owned.close(Exit.void))
			const parentExit = yield* Effect.exit(Scope.close(parent, Exit.void))
			if (Exit.isFailure(parentExit)) assert.deepStrictEqual(parentExit, first)
			assert.deepStrictEqual(first, second)
			assert.isTrue(Exit.isFailure(first))
			if (Exit.isFailure(first)) {
				assert.include(Cause.pretty(first.cause), "first cleanup defect")
				assert.include(Cause.pretty(first.cause), "second cleanup defect")
			}
		}).pipe(run),
	)
})
