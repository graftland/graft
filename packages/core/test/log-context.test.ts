import { Array, Effect, Layer, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { run } from "./b1b-utils.ts"

it.effect(
	"replays host logs without inventing mount identity and retains mount log annotations",
	() =>
		Effect.gen(function* () {
			yield* Effect.log("host log")
			const mount = yield* Graft.mount(
				Layer.effectDiscard(Effect.log("mount startup")),
				{ name: "logged mount" },
			)
			yield* mount.await
			const entries = yield* Graft.logs.pipe(Stream.take(2), Stream.runCollect)
			assert.deepStrictEqual(
				Array.map(entries, (entry) => entry.message),
				[["host log"], ["mount startup"]],
			)
			assert.deepStrictEqual(entries[0]?.annotations, {})
			const startup = entries[1]
			assert.strictEqual(startup?.annotations["graft.mount"], mount.id)
			assert.strictEqual(startup?.annotations["graft.name"], "logged mount")
		}).pipe(run),
)
