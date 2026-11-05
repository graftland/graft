import { Array, Effect, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

it.effect(
	"replays host logs without inventing plugin identity and retains plugin log annotations",
	() =>
		Effect.gen(function* () {
			const event = Event.make<[]>("log-context")
			yield* Effect.log("host log")
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "logged plugin",
					apply: () =>
						Effect.log("plugin startup").pipe(
							Effect.andThen(
								Event.on(event, () => Effect.log("plugin handler")),
							),
						),
				}),
			)
			yield* fork.await
			yield* Event.emit(event)
			const entries = yield* Graft.logs.pipe(Stream.take(3), Stream.runCollect)
			assert.deepStrictEqual(
				Array.map(entries, (entry) => entry.message),
				[["host log"], ["plugin startup"], ["plugin handler"]],
			)
			assert.deepStrictEqual(entries[0]?.annotations, {})
			for (const entry of Array.drop(entries, 1)) {
				assert.strictEqual(entry.annotations["graft.fork"], fork.id)
				assert.strictEqual(entry.annotations["graft.plugin"], "logged plugin")
			}
		}).pipe(run),
)
