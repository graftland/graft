import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { makeJournal, reach, run } from "./b1c-utils.ts"

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
				const mode = yield* Ref.make("initial")
				const journal = yield* makeJournal
				let calls = 0
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const value = yield* Ref.get(mode)
							yield* journal.record(value)
						}),
					),
					{
						name: "intercepted",
						retry: Schedule.recurs(3),
						intercept: [
							Graft.intercept(Setting, (value) => {
								calls++
								if (Ref.getUnsafe(broken)) throw new Error("intercept failed")
								return value + 1
							}),
						],
					},
				)
				const failed = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(failed))
				if (Exit.isFailure(failed)) assert.isTrue(Cause.hasDies(failed.cause))
				yield* TestClock.adjust("1 second")
				assert.strictEqual(calls, 1)
				yield* journal.expect([])
				yield* Ref.set(mode, "latest")
				yield* mount.restart
				yield* reach(mount, "Failed")
				assert.strictEqual(calls, 2)
				yield* Ref.set(broken, false)
				yield* mount.restart
				yield* reach(mount, "Active")
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
				const mount = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "broken wrapper",
					intercept: [intercept],
				})
				const result = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) assert.isTrue(Cause.hasDies(result.cause))
				yield* mount.restart
				yield* reach(mount, "Failed")
			}).pipe(run),
	)
	it.effect("settles an intercept that explicitly interrupts supervision", () =>
		Effect.gen(function* () {
			const mount = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
				name: "interrupted wrapper",
				intercept: [{ apply: () => Effect.interrupt }],
			})
			yield* reach(mount, "Failed")
			const snapshot = yield* Stream.runHead(mount.state)
			const state = Option.getOrThrow(snapshot)
			assert.strictEqual(state._tag, "Failed")
			if (state._tag === "Failed")
				assert.isTrue(Cause.hasInterruptsOnly(state.cause))
			const result = yield* Effect.exit(mount.await)
			assert.isTrue(Exit.isFailure(result))
		}).pipe(run),
	)
})
