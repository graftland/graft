import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Event, Graft, Plugin, type Fork } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

// Each test replays the reproduction from a cordis issue, so these lifecycle
// races stay covered in Graft as well.

class Logger extends Context.Service<
	Logger,
	{ readonly log: (line: string) => Effect.Effect<void> }
>()("@graftland/graft/test/cordis-scenarios.test/Logger") {}

const settle = Effect.forEach(Array.range(1, 50), () => Effect.yieldNow, {
	discard: true,
})

const currentState = (fork: Fork.Fork) =>
	fork.state.pipe(Stream.runHead, Effect.map(Option.getOrThrow))

describe("cordis scenarios", () => {
	// cordiverse/cordis#194
	it.effect("does not let an older update finish after a newer one", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const started = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "slow update",
					config: Schema.Finite,
					apply: (value) =>
						Effect.gen(function* () {
							yield* journal.record(`apply ${value}`)
							return (next: number) =>
								Effect.gen(function* () {
									if (next === 1) {
										yield* Deferred.succeed(started, undefined)
										yield* Deferred.await(release)
									}
									yield* journal.record(`update ${next}`)
									return true
								})
						}),
				}),
				0,
			)
			yield* fork.await
			const first = yield* Effect.forkScoped(fork.update(1))
			yield* Deferred.await(started)
			const second = yield* Effect.forkScoped(fork.update(2))
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
			yield* journal.expect(["apply 0", "update 1", "update 2"])
		}).pipe(run),
	)

	// cordiverse/cordis#34
	it.effect("applies a configuration that arrives while apply runs", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const started = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "update while loading",
					config: Schema.Finite,
					apply: (value) =>
						Effect.gen(function* () {
							yield* journal.record(`apply ${value}`)
							if (value === 1) {
								yield* Deferred.succeed(started, undefined)
								yield* Deferred.await(release)
							}
						}),
				}),
				1,
			)
			yield* Deferred.await(started)
			const update = yield* Effect.forkScoped(fork.update(2))
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(update)
			yield* fork.await
			yield* journal.expect(["apply 1", "apply 2"])
		}).pipe(run),
	)

	// cordiverse/cordis#26
	it.effect("keeps a service open until its consumers finish cleanup", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const logger = Plugin.make({
				name: "logger",
				apply: () =>
					Effect.gen(function* () {
						const open = yield* Ref.make(true)
						yield* Effect.addFinalizer(() =>
							Ref.set(open, false).pipe(
								Effect.andThen(journal.record("logger closed")),
							),
						)
						yield* Graft.provide(Logger, {
							log: (line) =>
								Effect.flatMap(Ref.get(open), (isOpen) =>
									journal.record(isOpen ? line : `closed: ${line}`),
								),
						})
					}),
			})
			const consumer = Plugin.make({
				name: "consumer",
				inject: [Logger],
				apply: () =>
					Effect.gen(function* () {
						const logger = yield* Logger
						yield* logger.log("start")
						yield* Effect.addFinalizer(() =>
							settle.pipe(Effect.andThen(logger.log("end"))),
						)
					}),
			})
			const app = yield* Graft.plugin(
				Plugin.make({
					name: "app",
					apply: () =>
						Effect.gen(function* () {
							yield* Effect.flatMap(Graft.plugin(logger), (fork) => fork.await)
							yield* Effect.flatMap(
								Graft.plugin(consumer),
								(fork) => fork.await,
							)
						}),
				}),
			)
			yield* app.await
			yield* journal.expect(["start"])
			yield* app.dispose
			yield* journal.expect(["start", "end", "logger closed"])
		}).pipe(run),
	)

	// cordiverse/cordis#127
	it.effect("settles pending and failed forks on Disposed", () =>
		Effect.gen(function* () {
			const pending = yield* Graft.plugin(
				Plugin.make({
					name: "pending",
					inject: [Logger],
					apply: () => Effect.void,
				}),
			)
			const failed = yield* Graft.plugin(
				Plugin.make({ name: "failed", apply: () => Effect.fail("boom") }),
			)
			yield* reach(pending, "Pending")
			yield* reach(failed, "Failed")
			yield* pending.dispose
			yield* Effect.exit(failed.dispose)
			const pendingState = yield* currentState(pending)
			const failedState = yield* currentState(failed)
			assert.strictEqual(pendingState._tag, "Disposed")
			assert.strictEqual(failedState._tag, "Disposed")
		}).pipe(run),
	)

	// cordiverse/cordis#108
	it.effect("keeps a sibling running when a plugin fails", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const healthy = yield* Graft.plugin(
				Plugin.make({
					name: "healthy",
					apply: () => Effect.addFinalizer(() => journal.record("cleaned up")),
				}),
			)
			const broken = yield* Graft.plugin(
				Plugin.make({
					name: "broken",
					apply: () => Effect.die(new Error("plugin blew up")),
				}),
			)
			yield* reach(broken, "Failed")
			const healthyState = yield* currentState(healthy)
			assert.strictEqual(healthyState._tag, "Active")
			yield* healthy.dispose
			yield* journal.expect(["cleaned up"])
		}).pipe(run),
	)

	// cordiverse/cordis#42
	it.effect("runs the terminal once when middleware calls next twice", () =>
		Effect.gen(function* () {
			const event = Event.middleware<number, number>("next-twice")
			const calls = yield* Ref.make(0)
			yield* Event.on(event, (input, next) =>
				Effect.andThen(next(input), next(input)),
			)
			yield* Event.waterfall(event, 1, () =>
				Ref.updateAndGet(calls, (count) => count + 1),
			)
			const count = yield* Ref.get(calls)
			assert.strictEqual(count, 1)
		}).pipe(run),
	)
})
