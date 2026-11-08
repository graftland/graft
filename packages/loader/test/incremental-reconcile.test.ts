import { Context, Deferred, Effect, Fiber } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Loader } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

it.effect(
	"starts sibling updates before a slow update finishes and waits for both",
	() =>
		Effect.gen(function* () {
			const slow = yield* Deferred.make<void>()
			const fast = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const done = yield* Deferred.make<void>()

			yield* run({ leaf: fixture("incremental-reconcile-leaf-4007") })(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "slow", name: "leaf", config: "slow" },
						{ id: "fast", name: "leaf", config: "fast" },
					])
					const loader = yield* loaderService
					yield* loader.ready
					const updated = yield* loader.root
						.update([
							{ id: "slow", name: "leaf", config: "next" },
							{ id: "fast", name: "leaf", config: "next" },
						])
						.pipe(
							Effect.andThen(Deferred.succeed(done, undefined)),
							Effect.forkScoped,
						)
					yield* Deferred.await(slow)
					yield* Deferred.await(fast)
					const checked6 = yield* Deferred.isDone(done)

					assert.isFalse(checked6)
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(updated)
					yield* loader.ready
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{
						readonly slow: typeof slow
						readonly fast: typeof fast
						readonly release: typeof release
					}>("loader/fixture/incremental-reconcile-leaf-4007"),
					{ slow, fast, release },
				),
			)
		}),
)

it.effect("starts all removals before waiting for dependent cleanup", () =>
	Effect.gen(function* () {
		const first = yield* Deferred.make<void>()
		const second = yield* Deferred.make<void>()

		yield* run({ leaf: fixture("incremental-reconcile-leaf-5323") })(() =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "first", name: "leaf", config: "first" },
					{ id: "second", name: "leaf", config: "second" },
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.root.update([])
				yield* loader.ready
				const checked7 = yield* Deferred.isDone(first)

				assert.isTrue(checked7)
				const checked8 = yield* Deferred.isDone(second)

				assert.isTrue(checked8)
			}),
		).pipe(
			Effect.provideService(
				Context.Service<{
					readonly first: typeof first
					readonly second: typeof second
				}>("loader/fixture/incremental-reconcile-leaf-5323"),
				{ first, second },
			),
		)
	}),
)
