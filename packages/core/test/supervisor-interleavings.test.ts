import { Context, Deferred, Effect, Layer, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { current, makeJournal, reach, run } from "./b1c-utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/supervisor-interleavings.test/Service",
) {}

describe("supervisor interleavings", () => {
	it.effect(
		"accepts a restart while pending and builds once when the dependency arrives",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const mount = yield* Graft.mount(
					Layer.effectDiscard(Effect.flatMap(Service, journal.record)),
					{ name: "pending consumer", requires: [Service] },
				)
				yield* reach(mount, "Pending")
				yield* mount.restart
				const provider = yield* Graft.publish(Service, "ready")
				yield* provider.await
				yield* reach(mount, "Active")
				yield* journal.expect(["ready"])
			}).pipe(run),
	)

	it.effect(
		"interrupts loading before starting the restarted configuration",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const started = yield* Deferred.make<void>()
				const mode = yield* Ref.make<"initial" | "latest">("initial")
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const value = yield* Ref.get(mode)
							if (value === "initial") {
								yield* Deferred.succeed(started, undefined)
								return yield* Effect.never.pipe(
									Effect.ensuring(journal.record("initial stopped")),
								)
							}
							yield* journal.record(value)
						}),
					),
					{ name: "loading update" },
				)
				yield* Deferred.await(started)
				yield* Ref.set(mode, "latest")
				yield* mount.restart
				yield* mount.await
				yield* journal.expect(["initial stopped", "latest"])
			}).pipe(run),
	)

	it.effect(
		"accepts a restart during retry backoff without waiting for the timer",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const mode = yield* Ref.make<"broken" | "fixed">("broken")
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Ref.update(attempts, (n) => n + 1)
							if ((yield* Ref.get(mode)) === "broken")
								return yield* Effect.fail("broken configuration")
						}),
					),
					{ name: "retry update", retry: Schedule.spaced("1 hour") },
				)
				yield* reach(mount, "Failed")
				yield* Ref.set(mode, "fixed")
				yield* mount.restart
				yield* mount.await
				yield* TestClock.adjust("1 hour")
				const count = yield* Ref.get(attempts)
				const state = yield* current(mount)
				assert.strictEqual(count, 2)
				assert.strictEqual(state._tag, "Active")
			}).pipe(run),
	)
})
