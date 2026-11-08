import { Array, Context, Deferred, Effect, Fiber, Ref, Stream } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Loader } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

describe("target reconciliation", () => {
	it.effect("allows a finalizer to submit another edit", () =>
		run({ removable: fixture("removable") })(() =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "removable", name: "removable" },
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.remove("removable")
				yield* loader.ready
				const entries = yield* loader.entries
				assert.deepStrictEqual(
					Array.map(entries, (entry) => entry.id),
					["created"],
				)
			}),
		),
	)
	it.effect("allows an update handler to submit another edit", () =>
		run({ admin: fixture("admin") })(() =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "admin", name: "admin", config: 1 },
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.update("admin", { config: 2 })
				yield* loader.ready
				const entries = yield* loader.entries
				assert.deepStrictEqual(
					Array.map(entries, (entry) => entry.id),
					["admin", "created"],
				)
			}),
		),
	)

	it.effect(
		"publishes persisted targets while reconciliation is blocked and waits for the latest one",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const observed = yield* Ref.make<ReadonlyArray<number>>([])
				const completed = yield* Deferred.make<void>()
				class State extends Context.Service<
					State,
					{
						readonly entered: typeof entered
						readonly release: typeof release
						readonly observed: typeof observed
					}
				>()("@graftland/loader/test/reconciliation.test/State") {}
				yield* run({ updatable: fixture("reconciliation-updatable") })(() =>
					Effect.gen(function* () {
						yield* Graft.plugin(Loader.plugin, [
							{ id: "entry", name: "updatable", config: 0 },
						])
						const loader = yield* loaderService
						yield* loader.ready
						const changes = yield* loader.changes.pipe(
							Stream.take(4),
							Stream.runCollect,
							Effect.forkChild({ startImmediately: true }),
						)
						yield* loader.update("entry", { config: 1 })
						yield* Deferred.await(entered)
						const ready = yield* loader.ready.pipe(
							Effect.andThen(Deferred.succeed(completed, undefined)),
							Effect.forkChild({ startImmediately: true }),
						)
						yield* loader.update("entry", { config: 2 })
						yield* loader.update("entry", { config: 3 })
						const targets = yield* Fiber.join(changes)
						assert.deepStrictEqual(
							Array.map(targets, (entries) => entries[0]?.config),
							[0, 1, 2, 3],
						)
						const done = yield* Deferred.isDone(completed)
						assert.isFalse(done)
						yield* Deferred.succeed(release, undefined)
						yield* Fiber.join(ready)
						const values = yield* Ref.get(observed)
						assert.deepStrictEqual(values, [1, 3])
					}),
				).pipe(Effect.provideService(State, { entered, release, observed }))
			}),
	)
})
