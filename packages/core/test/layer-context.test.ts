import { assert, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref } from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

const Setting = Context.Reference<string>(
	"@graftland/graft/test/layer-context.test/Setting",
	{ defaultValue: () => "default" },
)

it.effect("publishes a reference's default through the layer context", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make("not read")
		const provider = yield* Graft.plugin(
			Plugin.layer(Layer.empty, {
				name: "default settings",
				provides: [Setting],
			}),
		)
		yield* provider.await
		const consumer = yield* Graft.plugin(
			Plugin.make({
				name: "settings consumer",
				inject: [Setting],
				apply: () => Effect.flatMap(Setting, (value) => Ref.set(seen, value)),
			}),
		)
		yield* consumer.await
		const value = yield* Ref.get(seen)
		assert.strictEqual(value, "default")
	}).pipe(run),
)
