import {
	Array,
	Cause,
	Deferred,
	Effect,
	Fiber,
	Option,
	Queue,
	Ref,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Entry, Loader, Tree } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

describe("store notification protocol", () => {
	it.effect(
		"reads a notification only after an in-progress API edit has committed",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const current = yield* Ref.make<ReadonlyArray<Entry.Entry>>([])
					const notifications = yield* Queue.unbounded<void>()
					const editing = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const delivered = yield* Deferred.make<void>()
					const refreshed = yield* Deferred.make<ReadonlyArray<Entry.Entry>>()
					yield* Graft.plugin(
						Plugin.make({
							name: "stored",
							apply: () =>
								Loader.start({
									initial: [],
									apply: (op) =>
										Effect.gen(function* () {
											yield* Deferred.succeed(editing, undefined)
											yield* Deferred.await(release)
											const previous = yield* Ref.get(current)
											const next = yield* Effect.fromResult(
												Tree.apply(previous, op),
											)
											yield* Ref.set(current, next)
											return next
										}),
									refresh: Ref.get(current).pipe(
										Effect.flatMap((entries) =>
											Deferred.succeed(refreshed, entries),
										),
										Effect.as(Option.none()),
									),
									external: Stream.fromQueue(notifications).pipe(
										Stream.tap(() => Deferred.succeed(delivered, undefined)),
									),
								}),
						}),
					)
					const loader = yield* loaderService
					yield* loader.ready
					const edit = yield* loader
						.create({ id: "a", name: "unused", disabled: true })
						.pipe(Effect.forkChild)
					yield* Deferred.await(editing)
					yield* Queue.offer(notifications, undefined)
					yield* Deferred.await(delivered)
					const early = yield* Deferred.isDone(refreshed)
					assert.isFalse(early)
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(edit)
					const read = yield* Deferred.await(refreshed)
					const entries = yield* loader.entries
					assert.deepStrictEqual(read, entries)
					assert.deepStrictEqual(
						Array.map(read, (entry) => entry.id),
						["a"],
					)
				}),
			),
	)

	it.effect(
		"records the complete cause if the notification stream terminates unexpectedly",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const defect = new Error("Notification backend failed")
					yield* Graft.plugin(
						Plugin.make({
							name: "stored",
							apply: () =>
								Loader.start({
									initial: [],
									apply: () => Effect.succeed([]),
									refresh: Effect.succeedNone,
									external: Stream.die(defect),
								}),
						}),
					)
					const result = yield* Graft.logs.pipe(
						Stream.filter(
							(entry) =>
								Array.isArray(entry.message) &&
								Array.contains(
									entry.message,
									"Loader change notifications stopped",
								),
						),
						Stream.runHead,
					)
					const logged = Option.getOrThrow(result)
					assert.strictEqual(Cause.squash(logged.cause), defect)
				}),
			),
	)
})
