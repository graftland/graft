import { assert, describe, it } from "@effect/vitest"
import {
	Cause,
	Context,
	Effect,
	Exit,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

const Setting = Context.Reference<number>(
	"@graftland/graft/test/supervisor-boundary.test/Setting",
	{ defaultValue: () => 0 },
)

describe("supervisor failure boundary", () => {
	it.effect(
		"settles intercept defects and retries only after a specification change",
		() =>
			Effect.gen(function* () {
				const broken = yield* Ref.make(true)
				const journal = yield* makeJournal
				let calls = 0
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "intercepted",
						config: Schema.String,
						retry: Schedule.recurs(3),
						apply: (input) => journal.record(input),
					}),
					"initial",
					{
						intercept: [
							Graft.intercept(Setting, (value) => {
								calls++
								if (Ref.getUnsafe(broken)) throw new Error("intercept failed")
								return value + 1
							}),
						],
					},
				)
				const failed = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(failed))
				if (Exit.isFailure(failed)) assert.isTrue(Cause.hasDies(failed.cause))
				yield* TestClock.adjust("1 second")
				assert.strictEqual(calls, 1)
				yield* journal.expect([])
				yield* fork.update("latest")
				yield* reach(fork, "Failed")
				assert.strictEqual(calls, 2)
				yield* Ref.set(broken, false)
				yield* fork.restart
				yield* reach(fork, "Active")
				assert.strictEqual(calls, 3)
				yield* journal.expect(["latest"])
			}).pipe(run),
	)

	it.effect(
		"catches synchronous failures while constructing an intercept wrapper",
		() =>
			Effect.gen(function* () {
				const intercept: Graft.Intercept = {
					apply: () => {
						throw new Error("wrapper failed")
					},
				}
				const fork = yield* Graft.plugin(
					Plugin.make({ name: "broken wrapper", apply: () => Effect.void }),
					undefined,
					{ intercept: [intercept] },
				)
				const result = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) assert.isTrue(Cause.hasDies(result.cause))
				yield* fork.update(undefined)
				yield* reach(fork, "Failed")
			}).pipe(run),
	)
	it.effect("settles an intercept that explicitly interrupts supervision", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({ name: "interrupted wrapper", apply: () => Effect.void }),
				undefined,
				{ intercept: [{ apply: () => Effect.interrupt }] },
			)
			yield* TestClock.adjust("1 millis")
			const snapshot = yield* Stream.runHead(fork.state)
			const state = Option.getOrThrow(snapshot)
			assert.strictEqual(state._tag, "Failed")
			if (state._tag === "Failed")
				assert.isTrue(Cause.hasInterruptsOnly(state.cause))
			const result = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(result))
		}).pipe(run),
	)
})
