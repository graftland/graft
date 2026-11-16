import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"
import { reach, run } from "./utils.ts"

it.effect(
	"does not rerun a failed intercept because of an already accepted restart",
	() =>
		Effect.gen(function* () {
			const fail = yield* Deferred.make<void>()
			const calls = yield* Ref.make(0)
			const intercept: Graft.Intercept = {
				apply: (effect) =>
					Ref.update(calls, (n) => n + 1).pipe(
						Effect.andThen(
							Effect.raceFirst(
								effect,
								Deferred.await(fail).pipe(
									Effect.andThen(Effect.die("intercept failure")),
								),
							),
						),
					),
			}
			const builds = yield* Ref.make(0)
			const rebuilding = yield* Deferred.make<void>()
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const build = yield* Ref.updateAndGet(builds, (n) => n + 1)
						if (build === 2) yield* Deferred.succeed(rebuilding, undefined)
					}),
				),
				{
					name: "restarted mount",
					intercept: [intercept],
				},
			)
			yield* mount.await
			// The restart is accepted before the intercept fails, so it cannot be rerun afterwards.
			yield* mount.restart.pipe(Effect.forkScoped)
			yield* Deferred.await(rebuilding)
			yield* Deferred.succeed(fail, undefined)
			yield* reach(mount, "Failed")
			// Wait for the supervisor to settle without relying on the first Failed emission.
			yield* TestClock.adjust("1 millis")
			const actual = yield* Ref.get(calls)
			const finalBuilds = yield* Ref.get(builds)
			yield* mount.unmount
			assert.strictEqual(actual, 1, `calls=${actual} builds=${finalBuilds}`)
			assert.strictEqual(finalBuilds, 2)
		}).pipe(run),
)

it.effect(
	"does not consume a restart that arrives while intercept failure is cleaning up",
	() =>
		Effect.gen(function* () {
			const fail = yield* Deferred.make<void>()
			const cleaning = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const calls = yield* Ref.make(0)
			const builds = yield* Ref.make(0)
			const intercept: Graft.Intercept = {
				apply: (effect) =>
					Effect.flatMap(
						Ref.updateAndGet(calls, (n) => n + 1),
						(call) =>
							call === 1
								? Effect.raceFirst(
										effect,
										Deferred.await(fail).pipe(
											Effect.andThen(Effect.die("wrapper failed")),
										),
									)
								: effect,
					),
			}
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const build = yield* Ref.updateAndGet(builds, (n) => n + 1)
						if (build === 1)
							yield* Effect.addFinalizer(() =>
								Deferred.succeed(cleaning, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
								),
							)
					}),
				),
				{ name: "intercept recovery", intercept: [intercept] },
			)
			yield* mount.await
			yield* Deferred.succeed(fail, undefined)
			yield* Deferred.await(cleaning)
			const restarting = yield* Effect.forkScoped(mount.restart)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(restarting)
			yield* mount.await
			const count = yield* Ref.get(calls)
			const attempts = yield* Ref.get(builds)
			assert.strictEqual(count, 2)
			assert.strictEqual(attempts, 2)
		}).pipe(run),
)

it.effect("attributes an intercept failure to an in-progress restart", () =>
	Effect.gen(function* () {
		const updating = yield* Deferred.make<void>()
		const building = yield* Deferred.make<void>()
		const calls = yield* Ref.make(0)
		const builds = yield* Ref.make(0)
		const intercept: Graft.Intercept = {
			apply: (effect) =>
				Ref.update(calls, (n) => n + 1).pipe(
					Effect.andThen(
						Effect.raceFirst(
							effect,
							Deferred.await(updating).pipe(
								Effect.andThen(Effect.die("update wrapper failed")),
							),
						),
					),
				),
		}
		const mount = yield* Graft.mount(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const build = yield* Ref.updateAndGet(builds, (n) => n + 1)
					if (build === 2) {
						yield* Deferred.succeed(building, undefined)
						return yield* Effect.never
					}
				}),
			),
			{ name: "interrupted restart", intercept: [intercept] },
		)
		yield* mount.await
		const restarting = yield* Effect.forkScoped(mount.restart)
		yield* Deferred.await(building)
		yield* Fiber.join(restarting)
		yield* Deferred.succeed(updating, undefined)
		yield* reach(mount, "Failed")
		yield* TestClock.adjust("1 millis")
		const count = yield* Ref.get(calls)
		const attempts = yield* Ref.get(builds)
		const exit = yield* Effect.exit(mount.await)
		assert.strictEqual(count, 1)
		assert.strictEqual(attempts, 2)
		assert.isTrue(Exit.isFailure(exit))
		if (Exit.isFailure(exit))
			assert.include(Cause.pretty(exit.cause), "update wrapper failed")
	}).pipe(run),
)
