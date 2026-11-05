import { Array, Deferred, Effect, Fiber, Ref, Schema, Stream } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Loader } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

describe("target reconciliation", () => {
	it.effect("allows a finalizer to submit another edit", () =>
		run(() => ({
			removable: Plugin.make({
				name: "removable",
				inject: [Loader.Loader],
				apply: () =>
					Effect.gen(function* () {
						const loader = yield* Loader.Loader
						yield* Effect.addFinalizer(() =>
							loader
								.create({ id: "created", name: "unused", disabled: true })
								.pipe(Effect.orDie),
						)
					}),
			}),
		}))(() =>
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
		run(() => ({
			admin: Plugin.make({
				name: "admin",
				config: Schema.Finite,
				inject: [Loader.Loader],
				apply: () =>
					Effect.gen(function* () {
						const loader = yield* Loader.Loader
						return (_next: number) =>
							loader
								.create({ id: "created", name: "unused", disabled: true })
								.pipe(Effect.orDie, Effect.as(true))
					}),
			}),
		}))(() =>
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
				yield* run(() => ({
					updatable: Plugin.make({
						name: "updatable",
						config: Schema.Finite,
						apply: () =>
							Effect.succeed((value: number) =>
								Effect.gen(function* () {
									if (value === 1) {
										yield* Deferred.succeed(entered, undefined)
										yield* Deferred.await(release)
									}
									yield* Ref.update(observed, (values) => [...values, value])
									return true
								}),
							),
					}),
				}))(() =>
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
				)
			}),
	)
})
