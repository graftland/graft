import { Context, Effect, Layer, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { run } from "./b1b-utils.ts"

const Setting = Context.Reference<string>(
	"@graftland/graft/test/layer-context.test/Setting",
	{ defaultValue: () => "default" },
)

it.effect("publishes a reference's default through the layer context", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make("not read")
		const provider = yield* Graft.mount(Layer.effect(Setting, Setting), {
			name: "default settings",
		})
		yield* provider.await
		const consumer = yield* Graft.mount(
			Layer.effectDiscard(
				Effect.flatMap(Setting, (value) => Ref.set(seen, value)),
			),
			{ name: "settings consumer", requires: [Setting] },
		)
		yield* consumer.await
		const value = yield* Ref.get(seen)
		assert.strictEqual(value, "default")
	}).pipe(run),
)
