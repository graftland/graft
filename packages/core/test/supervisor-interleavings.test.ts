import { assert, describe, it } from "@effect/vitest"
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/supervisor-interleavings.test/Service",
) {}

describe("supervisor interleavings", () => {
	it.effect(
		"accepts pending updates and applies only the latest input when dependencies arrive",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "pending consumer",
						inject: [Service],
						config: Schema.String,
						apply: journal.record,
					}),
					"initial",
				)
				yield* reach(fork, "Pending")
				yield* fork.update("middle")
				yield* fork.update("latest")
				yield* Graft.provide(Service, "ready")
				yield* reach(fork, "Active")
				yield* journal.expect(["latest"])
			}).pipe(run),
	)

	it.effect(
		"interrupts loading before starting the updated configuration",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const started = yield* Deferred.make<void>()
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "loading update",
						config: Schema.String,
						apply: (input) =>
							input === "initial"
								? Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(journal.record("initial stopped")),
									)
								: journal.record(input),
					}),
					"initial",
				)
				yield* Deferred.await(started)
				yield* fork.update("latest")
				yield* fork.await
				yield* journal.expect(["initial stopped", "latest"])
			}).pipe(run),
	)

	it.effect(
		"settles both callers when an update supersedes a blocked in-place update",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const started = yield* Deferred.make<void>()
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "overlapping updates",
						config: Schema.String,
						apply: (input) =>
							Effect.gen(function* () {
								yield* journal.record(`apply ${input}`)
								return () =>
									Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(journal.record("update stopped")),
									)
							}),
					}),
					"initial",
				)
				yield* fork.await
				const first = yield* Effect.forkScoped(fork.update("middle"))
				yield* Deferred.await(started)
				const second = yield* Effect.forkScoped(fork.update("latest"))
				yield* Fiber.join(first)
				yield* Fiber.join(second)
				yield* fork.await
				yield* journal.expect([
					"apply initial",
					"update stopped",
					"apply latest",
				])
			}).pipe(run),
	)

	it.effect(
		"accepts a new configuration during retry backoff without waiting for the timer",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "retry update",
						config: Schema.String,
						retry: Schedule.spaced("1 hour"),
						apply: (input) =>
							Ref.update(attempts, (n) => n + 1).pipe(
								Effect.andThen(
									input === "broken"
										? Effect.fail("broken configuration")
										: Effect.void,
								),
							),
					}),
					"broken",
				)
				yield* reach(fork, "Failed")
				yield* fork.update("fixed")
				yield* fork.await
				yield* TestClock.adjust("1 hour")
				const count = yield* Ref.get(attempts)
				const state = yield* Stream.runHead(fork.state)
				assert.strictEqual(count, 2)
				assert.strictEqual(Option.getOrThrow(state)._tag, "Active")
			}).pipe(run),
	)
})
