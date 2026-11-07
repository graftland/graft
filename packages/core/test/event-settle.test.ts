import { Array, Effect, Exit } from "effect"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

const Answer = Event.make<[], number, string>(
	"@graftland/graft/test/event-settle.test/Answer",
)

const answering = (name: string, answer: Effect.Effect<number, string>) =>
	Plugin.make({ name, apply: () => Event.on(Answer, () => answer) })

it.effect("returns every handler's outcome, failures included", () =>
	Effect.gen(function* () {
		for (const plugin of [
			answering("one", Effect.succeed(1)),
			answering("broken", Effect.fail("broken")),
			answering("defect", Effect.die("defect")),
			answering("two", Effect.succeed(2)),
		]) {
			const fork = yield* Graft.plugin(plugin)
			yield* fork.await
		}
		const outcomes = yield* Event.settle(Answer)
		assert.deepStrictEqual(
			Array.map(outcomes, (exit) =>
				Exit.isSuccess(exit) ? exit.value : "failed",
			),
			[1, "failed", "failed", 2],
		)
	}).pipe(run),
)
